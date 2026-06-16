const DATA_ROOT = './data/';
const R18_DATA_ROOT = './data_r18_all/';
const CHARA_DATA_ROOT = `${DATA_ROOT}chara/`;
const CHARA_EMOTION_ROOT = `${DATA_ROOT}emotion/charastand/`;
const BG_DATA_ROOT = `${DATA_ROOT}backgrounds/novel/`;
const LIVE2D_TAG = 'Live2DTag';
const L2D_DEFAULT_IDLE_MOTION = 'scene01_loop';
const L2D_GROUP_PRIORITY = [
  'NaturalIdle',
  'Scene',
  'FaceEmotion',
  'FaceAngle',
  'EyeEmotion',
  'EyeOpen',
  'EyebrowEmotion',
  'MouthEmotion',
  'LipSync',
];
const L2D_LIP_SYNC = {
  layer: 'LipSync',
  mouthParameterPrefix: 'ParamMouthOpenY',
  suffixPattern: /^\d+$/,
  targetWaitSec: 0.06,
  blendModeSwitchTimeBeforeEnd: 0.3,
  lowFreqThreshold: 14700,
  midFreqThreshold: 29400,
  highFreqThreshold: 44100,
  lowFreqEnhancer: 1,
  midFreqEnhancer: 10,
  highFreqEnhancer: 100,
  maxMouthYSize: 150,
  webGLPeakLevelMultiplier: 7,
};
const L2D_NATURAL_IDLE = {
  layer: 'NaturalIdle',
  breathSeconds: 3.4,
  bodySeconds: 4.8,
  hairSeconds: 5.8,
  blinkIntervalSeconds: 4.2,
  blinkDurationSeconds: 0.18,
  fallbackEyeOpen: 0.72,
};
const AUTO_CHECK_MS = 100;
const AUTO_AFTER_VOICE_MS = 350;
const MOSAIC_PIXEL_DIV_X = 80;
const MOSAIC_PIXEL_DIV_Y = 45;
const MOSAIC_PADDING_PX = 2;

const el = {};
const app = {
  index: null,
  globalAudio: { cues: {} },
  emotionAssets: new Map(),
  backgroundAssets: new Map(),
  story: null,
  storyMeta: null,
  script: null,
  current: -1,
  running: false,
  auto: false,
  autoTimer: null,
  runToken: 0,
  asyncToken: 0,
  labels: new Map(),
  registry: null,
  controller: null,
};

document.addEventListener('DOMContentLoaded', async () => {
  bindElements();
  bindEvents();
  app.registry = buildCommandRegistry();
  app.controller = new NovelModelController();
  exposeManualReader();
  await loadIndex();
});

function bindElements() {
  for (const id of [
    'storyCount', 'storyList', 'storyTitle', 'storyMeta', 'stage', 'live2dCanvas',
    'bgLayer', 'mosaicLayer', 'fallbackTexture', 'sceneLayer', 'screenEffectLayer', 'transitionLayer', 'fadeLayer', 'motionBadge', 'statusLine',
    'messageBox', 'speaker', 'message', 'prevBtn', 'nextBtn', 'stepBtn', 'autoBtn',
    'seek', 'position', 'commandList', 'modelInfo', 'stateInfo', 'fitBtn', 'reloadBtn', 'mosaicMode',
  ]) {
    el[id] = document.getElementById(id);
  }
}

function bindEvents() {
  el.nextBtn.addEventListener('click', () => { app.controller.sound.unlock(); nextText(); });
  el.prevBtn.addEventListener('click', () => { app.controller.sound.unlock(); previousText(); });
  el.stepBtn.addEventListener('click', () => { app.controller.sound.unlock(); stepCommand(); });
  el.autoBtn.addEventListener('click', () => { app.controller.sound.unlock(); toggleAuto(); });
  el.seek.addEventListener('input', () => jumpTo(Number(el.seek.value)));
  el.mosaicMode.addEventListener('change', () => {
    app.controller.live2d.setMosaicMode(el.mosaicMode.value);
    updateInspectors();
  });
  el.fitBtn.addEventListener('click', () => app.controller.live2d.fit());
  el.reloadBtn.addEventListener('click', () => app.story && loadStory(app.story.id));
  document.addEventListener('pointerdown', () => app.controller.sound.unlock());
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });
  window.addEventListener('resize', () => app.controller.live2d.fit());
}

async function loadIndex() {
  const primaryIndex = await fetchJsonOptional(`${DATA_ROOT}index.json`, { stories: [] });
  const r18Index = await fetchJsonOptional(`${R18_DATA_ROOT}index.json`, { stories: [] });
  const storiesById = new Map();
  for (const source of [
    { root: DATA_ROOT, index: primaryIndex },
    { root: R18_DATA_ROOT, index: r18Index },
  ]) {
    for (const story of source.index.stories || []) {
      storiesById.set(String(story.id), { ...story, dataRoot: source.root });
    }
  }
  app.index = { ...primaryIndex, stories: Array.from(storiesById.values()) };
  app.globalAudio = await loadGlobalAudioSources();
  const emotionIndex = await fetchJsonOptional(`${CHARA_EMOTION_ROOT}index.json`, { emotions: [] });
  app.emotionAssets = new Map((emotionIndex.emotions || []).map((item) => [normalizeAssetKey(item.id), item]));
  const backgroundIndex = await fetchJsonOptional(`${BG_DATA_ROOT}index.json`, { backgrounds: {} });
  app.backgroundAssets = new Map(Object.entries(backgroundIndex.backgrounds || {}).map(([key, item]) => [normalizeAssetKey(key), item]));
  el.storyCount.textContent = `${app.index.stories.length} stories`;
  renderStoryList();
  if (app.index.stories.length) {
    await loadStory(app.index.stories[0].id);
  } else {
    el.storyMeta.textContent = 'No extracted story data';
  }
}

async function loadGlobalAudioSources() {
  const sources = [];
  for (const root of [DATA_ROOT, R18_DATA_ROOT]) {
    const index = await fetchJsonOptional(`${root}audio/se/index.json`, null);
    if (index?.cues) sources.push({ basePath: root, cues: index.cues });
  }
  return { sources };
}

async function loadStory(storyId) {
  const meta = app.index.stories.find((story) => story.id === storyId);
  if (!meta) return;
  stopAuto();
  app.runToken += 1;
  app.asyncToken += 1;
  app.storyMeta = meta;
  app.story = await fetchJson(`${meta.dataRoot || DATA_ROOT}${meta.path}`);
  app.script = app.story.scripts[0] || { commands: [], messages: [] };
  app.current = -1;
  app.running = false;
  app.labels = buildLabels(app.script.commands);
  const basePath = storyBasePath(meta);
  app.controller.reset(app.story, basePath);
  app.controller.live2d.setMosaicMode(el.mosaicMode.value);
  await app.controller.live2d.loadStory(app.story, basePath);
  app.controller.sound.loadStory(app.story, basePath);
  el.storyTitle.textContent = meta.title || meta.id;
  el.storyMeta.textContent = `${app.script.commands.length} commands / ${app.script.messages.length} messages`;
  el.seek.max = Math.max(0, app.script.commands.length - 1);
  el.seek.value = 0;
  renderStoryList();
  renderCommandList();
  updateInspectors();
  await nextText();
}

function buildLabels(commands) {
  const labels = new Map();
  for (const command of commands) {
    if (String(command.command).toLowerCase() === ':label') {
      const label = command.label || String(command.rawCommand || '').replace(/^:/, '') || command.args?.[0];
      if (label) labels.set(String(label).toLowerCase(), command.index);
    }
  }
  return labels;
}

function storyBasePath(meta = app.storyMeta) {
  const root = meta?.dataRoot || DATA_ROOT;
  const path = String(meta?.path || `stories/${app.story?.id || ''}/story.json`);
  const slash = path.lastIndexOf('/');
  return `${root}${slash >= 0 ? path.slice(0, slash + 1) : ''}`;
}

function renderStoryList() {
  el.storyList.innerHTML = '';
  for (const story of app.index.stories) {
    const item = document.createElement('div');
    item.className = `story-item${app.story?.id === story.id ? ' active' : ''}`;
    item.innerHTML = `
      <div class="story-item-title">${escapeHtml(story.title || story.id)}</div>
      <div class="story-item-meta">${story.stats.messageCount} text / ${story.stats.motionCount || 0} motions / ${story.stats.audioCueCount || 0} audio</div>
    `;
    item.addEventListener('click', () => loadStory(story.id));
    el.storyList.appendChild(item);
  }
}

function renderCommandList() {
  el.commandList.innerHTML = '';
  for (const command of app.script.commands) {
    const item = document.createElement('div');
    item.className = 'command-item';
    item.dataset.index = command.index;
    item.innerHTML = `
      <div>${command.index.toString().padStart(4, '0')} ${escapeHtml(command.rawCommand || command.command)}</div>
      <div class="command-meta">${escapeHtml((command.args || []).join(' | '))}</div>
    `;
    item.addEventListener('click', () => jumpTo(command.index));
    el.commandList.appendChild(item);
  }
}

async function nextText() {
  if (app.running || !app.script) return;
  completeCurrentMessagePause();
  app.running = true;
  const token = ++app.runToken;
  try {
    while (app.current + 1 < app.script.commands.length && token === app.runToken) {
      const result = await executeAt(app.current + 1, token, false);
      if (result?.jumpIndex != null) {
        app.current = result.jumpIndex - 1;
        continue;
      }
      if (result?.pauseOnText) break;
    }
  } finally {
    app.running = false;
    updatePosition();
    queueAuto();
  }
}

async function stepCommand() {
  if (app.running || !app.script || app.current + 1 >= app.script.commands.length) return;
  completeCurrentMessagePause();
  app.running = true;
  const token = ++app.runToken;
  try {
    await executeAt(app.current + 1, token, false);
  } finally {
    app.running = false;
    updatePosition();
    queueAuto();
  }
}

async function executeAt(index, token, replaying, replayTargetIndex = -1) {
  const command = app.script.commands[index];
  app.current = index;
  const context = new NovelContext(app, app.controller, token, replaying, replayTargetIndex);
  const result = await app.registry.execute(context, command);
  app.controller.scene.render();
  updatePosition();
  updateInspectors();
  return result;
}

async function previousText() {
  if (!app.script) return;
  const textIndexes = app.script.commands
    .filter((command) => isTextPauseCommand(command.command))
    .map((command) => command.index)
    .filter((index) => index < app.current);
  const target = textIndexes.length ? textIndexes[textIndexes.length - 1] : 0;
  await replayTo(target);
}

async function jumpTo(index) {
  await replayTo(clamp(index, 0, app.script.commands.length - 1));
}

async function replayTo(index) {
  stopAuto();
  const token = ++app.runToken;
  app.asyncToken += 1;
  const basePath = storyBasePath();
  app.controller.reset(app.story, basePath);
  await app.controller.live2d.loadStory(app.story, basePath);
  app.controller.sound.loadStory(app.story, basePath);
  app.current = -1;
  for (let i = 0; i <= index; i += 1) {
    const result = await executeAt(i, token, true, index);
    if (result?.jumpIndex != null && result.jumpIndex <= index) i = result.jumpIndex - 1;
  }
  const voiceCue = app.controller.message.state.voiceCue;
  if (voiceCue) {
    app.controller.sound.play(voiceCue, 'voice', 'voice', { volume: 1 });
    app.controller.live2d.playLipSync(voiceCue, true);
  }
  queueAuto();
}

async function replayStoryForTest(storyId) {
  await loadStory(storyId);
  stopAuto();
  const token = ++app.runToken;
  app.asyncToken += 1;
  const basePath = storyBasePath();
  app.controller.reset(app.story, basePath);
  await app.controller.live2d.loadStory(app.story, basePath);
  app.controller.sound.loadStory(app.story, basePath);
  app.current = -1;
  for (let i = 0; i < app.script.commands.length; i += 1) {
    const result = await executeAt(i, token, true, app.script.commands.length - 1);
    if (result?.jumpIndex != null && result.jumpIndex >= 0 && result.jumpIndex < app.script.commands.length) {
      app.current = result.jumpIndex;
    }
  }
  return {
    storyId: app.story.id,
    commands: app.script.commands.length,
    current: app.current,
    registry: commandRegistrySnapshot(),
  };
}

async function executeCommandForTest(commandName, args = [], replaying = true) {
  const token = ++app.runToken;
  const command = { index: 0, command: commandName, rawCommand: commandName, args };
  return app.registry.execute(new NovelContext(app, app.controller, token, replaying), command);
}

function commandRegistrySnapshot() {
  return Array.from(app.registry.commands.keys()).sort();
}

function exposeManualReader() {
  window.manualReader = {
    app,
    loadStory,
    nextText,
    stepCommand,
    replayTo,
    replayStoryForTest,
    executeCommandForTest,
    commandRegistrySnapshot,
  };
}

function updatePosition() {
  el.seek.value = Math.max(0, app.current);
  el.position.textContent = `${Math.max(0, app.current + 1)} / ${app.script?.commands.length || 0}`;
  document.querySelectorAll('.command-item').forEach((item) => {
    item.classList.toggle('active', Number(item.dataset.index) === app.current);
  });
  const active = el.commandList.querySelector('.command-item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function updateInspectors() {
  el.modelInfo.textContent = JSON.stringify({
    live2dReady: app.controller.live2d.ready,
    live2dVisible: app.controller.live2d.visible,
    motion: app.controller.live2d.currentMotion,
    mosaic: {
      mode: app.controller.live2d.mosaicMode,
      status: app.controller.live2d.mosaicStatus,
      drawables: app.controller.live2d.mosaicDrawables?.map((item) => `${item.id}:${item.material}`) || [],
    },
    audio: app.controller.sound.currentLabels(),
  }, null, 2);
  el.stateInfo.textContent = JSON.stringify({
    current: app.current,
    message: app.controller.message.state,
    scene: app.controller.scene.state,
    pendingAsync: app.controller.async.pendingLabels(),
  }, null, 2);
}

function toggleAuto() {
  app.auto = !app.auto;
  el.autoBtn.classList.toggle('active', app.auto);
  queueAuto();
}

function stopAuto() {
  app.auto = false;
  el.autoBtn.classList.remove('active');
  if (app.autoTimer) clearTimeout(app.autoTimer);
  app.autoTimer = null;
}

function completeCurrentMessagePause() {
  const command = app.script?.commands?.[app.current];
  if (!command || !isTextPauseCommand(command.command)) return;
  app.controller.sound.stopVoiceAll();
  app.controller.live2d.stopLipSync();
}

function queueAuto() {
  if (app.autoTimer) clearTimeout(app.autoTimer);
  if (!app.auto || app.running) return;
  const state = app.controller.message.state;
  const text = state.text || '';
  const textMs = clamp(1600 + text.length * 55, 2200, 12000);
  const shownAt = state.shownAt || performance.now();
  const textRemainingMs = Math.max(0, textMs - (performance.now() - shownAt));
  const voiceCue = state.voiceCue || '';
  const voiceDurationMs = voiceCue ? Math.max(0, app.controller.sound.cueDuration(voiceCue) * 1000) : 0;
  const voiceEstimatedRemainingMs = voiceDurationMs > 0
    ? Math.max(0, voiceDurationMs - (performance.now() - shownAt))
    : 0;
  if (voiceCue && app.controller.sound.isVoicePendingOrPlaying()) {
    const playingRemainingMs = app.controller.sound.remainingVoiceMs();
    const remainingMs = Math.max(textRemainingMs, voiceEstimatedRemainingMs, playingRemainingMs);
    app.autoTimer = setTimeout(queueAuto, Math.max(AUTO_CHECK_MS, Math.min(remainingMs || AUTO_CHECK_MS, 500)));
    return;
  }
  const endedAt = voiceCue ? app.controller.sound.voiceEndedAt(voiceCue) : 0;
  const afterVoiceRemainingMs = endedAt ? Math.max(0, AUTO_AFTER_VOICE_MS - (performance.now() - endedAt)) : 0;
  const waitMs = Math.max(textRemainingMs, voiceEstimatedRemainingMs, afterVoiceRemainingMs);
  app.autoTimer = setTimeout(() => {
    if (!app.auto || app.running) {
      queueAuto();
      return;
    }
    if (voiceCue && app.controller.sound.isVoicePendingOrPlaying()) {
      queueAuto();
      return;
    }
    nextText();
  }, waitMs > 0 ? Math.max(AUTO_CHECK_MS, waitMs) : 0);
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.id === `${name}Tab`));
}

class NovelContext {
  constructor(player, models, token, replaying, replayTargetIndex = -1) {
    this.player = player;
    this.models = models;
    this.token = token;
    this.asyncToken = player.asyncToken;
    this.replaying = replaying;
    this.replayTargetIndex = replayTargetIndex;
  }

  isReplayTarget(command) {
    return this.replaying && Number(command?.index) === Number(this.replayTargetIndex);
  }
}

class NovelArguments {
  constructor(command) {
    this.command = command;
    this.args = command.args || [];
  }

  string(index, fallback = '') {
    const value = this.args[index - 1];
    return value == null || value === '' ? fallback : String(value);
  }

  float(index, fallback = 0) {
    const value = Number.parseFloat(this.args[index - 1]);
    return Number.isFinite(value) ? value : fallback;
  }

  int(index, fallback = 0) {
    const value = Number.parseInt(this.args[index - 1], 10);
    return Number.isFinite(value) ? value : fallback;
  }

  on(index, fallback = true) {
    return parseOnOff(this.args[index - 1], fallback);
  }
}

class NovelModelController {
  constructor() {
    this.message = new NovelModelMessage();
    this.sound = new NovelModelSound();
    this.live2d = new NovelModelLive2D();
    this.screen = new NovelModelScreen();
    this.scene = new NovelModelScene();
    this.async = new NovelModelAsync();
  }

  reset(story, basePath) {
    this.message.reset();
    this.sound.stopAll();
    this.live2d.reset();
    this.screen.reset();
    this.scene.reset();
    this.async.reset();
    this.story = story;
    this.basePath = basePath;
  }
}

class NovelModelMessage {
  constructor() {
    this.reset();
  }

  reset() {
    this.state = { speaker: '', text: '', voiceCue: '', visible: true, shownAt: performance.now() };
    el.speaker.textContent = '';
    el.message.textContent = '';
    el.messageBox.style.opacity = '1';
  }

  show(speaker, text, voiceCue = '') {
    this.state = { speaker, text, voiceCue, visible: true, shownAt: performance.now() };
    el.speaker.textContent = speaker || '';
    el.message.innerHTML = escapeHtml(text || '').replace(/&lt;br&gt;/g, '<br>');
    el.messageBox.style.opacity = '1';
  }

  setWindow(visible, seconds) {
    this.state.visible = visible;
    el.messageBox.style.transitionDuration = `${Math.max(0, seconds) * 1000}ms`;
    el.messageBox.style.opacity = visible ? '1' : '0';
  }
}

class NovelModelScreen {
  constructor() {
    this.crossFadeSnapshot = null;
    this.crossFadeTimer = 0;
    this.transitionSnapshot = null;
    this.transitionTimer = 0;
  }

  reset() {
    this.state = { fade: null, blur: null, linework: null, colorFade: null, screenEffects: {} };
    el.fadeLayer.style.opacity = '0';
    el.fadeLayer.style.transitionDuration = '0ms';
    el.fadeLayer.style.background = '#000';
    el.screenEffectLayer.style.opacity = '0';
    el.screenEffectLayer.style.transitionDuration = '0ms';
    el.screenEffectLayer.style.background = 'rgba(0,0,0,0)';
    el.screenEffectLayer.style.filter = '';
    el.screenEffectLayer.dataset.effects = '';
    this.clearCrossFade();
    this.clearTransitionCrossFade();
    for (const layer of [el.bgLayer, el.live2dCanvas, el.mosaicLayer, el.fallbackTexture, el.sceneLayer]) {
      layer.style.transition = '';
      layer.style.filter = '';
    }
  }

  fade(direction, color, seconds) {
    const out = String(direction || '').toLowerCase() === 'out';
    this.state.fade = { direction, color, seconds };
    el.fadeLayer.style.background = cssColor(color || 'black');
    el.fadeLayer.style.transitionDuration = `${Math.max(0, seconds) * 1000}ms`;
    requestAnimationFrame(() => {
      el.fadeLayer.style.opacity = out ? '1' : '0';
    });
  }

  captureCrossFade() {
    this.crossFadeSnapshot = buildTransitionSnapshot();
    this.state.crossFadeCapture = { capturedAt: performance.now() };
  }

  crossFade(seconds, endX = 0, endY = 0, endScaleX = 1, endScaleY = 1) {
    const duration = Math.max(0, Number(seconds) || 0);
    const snapshot = this.crossFadeSnapshot || buildTransitionSnapshot();
    const rect = el.stage.getBoundingClientRect();
    const unitScale = Math.max(0.01, (rect.height || 1) / 2048);
    const tx = (Number(endX) || 0) * unitScale;
    const ty = -(Number(endY) || 0) * unitScale;
    const sx = Number.isFinite(Number(endScaleX)) ? Number(endScaleX) : 1;
    const sy = Number.isFinite(Number(endScaleY)) ? Number(endScaleY) : 1;
    this.state.crossFade = { seconds: duration, endX, endY, endScaleX: sx, endScaleY: sy };
    if (this.crossFadeTimer) clearTimeout(this.crossFadeTimer);
    if (this.transitionTimer) {
      clearTimeout(this.transitionTimer);
      this.transitionTimer = 0;
    }
    this.state.transition = null;
    el.transitionLayer.replaceChildren(snapshot);
    el.transitionLayer.dataset.effect = 'crossfade';
    el.transitionLayer.style.display = 'block';
    el.transitionLayer.style.opacity = '1';
    el.transitionLayer.style.transformOrigin = '50% 50%';
    el.transitionLayer.style.transform = 'translate(0px, 0px) scale(1, 1)';
    el.transitionLayer.style.transitionProperty = 'opacity, transform';
    el.transitionLayer.style.transitionTimingFunction = 'linear';
    el.transitionLayer.style.transitionDuration = '0ms';

    if (duration <= 0) {
      el.transitionLayer.style.transform = `translate(${tx}px, ${ty}px) scale(${sx}, ${sy})`;
      this.clearCrossFade();
      return;
    }

    requestAnimationFrame(() => {
      el.transitionLayer.style.transitionDuration = `${duration * 1000}ms`;
      el.transitionLayer.style.opacity = '0';
      el.transitionLayer.style.transform = `translate(${tx}px, ${ty}px) scale(${sx}, ${sy})`;
    });
    this.crossFadeTimer = setTimeout(() => this.clearCrossFade(), (duration * 1000) + 80);
  }

  clearCrossFade() {
    this.state.crossFade = null;
    if (this.crossFadeTimer) {
      clearTimeout(this.crossFadeTimer);
      this.crossFadeTimer = 0;
    }
    if (el.transitionLayer.dataset.effect === 'crossfade') {
      el.transitionLayer.replaceChildren();
      el.transitionLayer.style.display = 'none';
      el.transitionLayer.style.opacity = '0';
      el.transitionLayer.style.transform = '';
      el.transitionLayer.style.transformOrigin = '';
      el.transitionLayer.style.transitionDuration = '0ms';
      el.transitionLayer.style.transitionProperty = 'opacity';
      el.transitionLayer.dataset.effect = '';
    }
  }

  colorFade(seconds, r, g, b, fromAlpha, toAlpha) {
    const duration = Math.max(0, Number(seconds) || 0);
    const color = rgbaByte(r, g, b, 1);
    this.state.colorFade = { seconds: duration, r, g, b, fromAlpha, toAlpha };
    el.screenEffectLayer.style.background = color;
    el.screenEffectLayer.style.filter = el.screenEffectLayer.style.filter || '';
    el.screenEffectLayer.style.transitionDuration = '0ms';
    el.screenEffectLayer.style.opacity = String(byteToUnit(fromAlpha));
    requestAnimationFrame(() => {
      el.screenEffectLayer.style.transitionDuration = `${duration * 1000}ms`;
      el.screenEffectLayer.style.opacity = String(byteToUnit(toAlpha));
    });
  }

  screenEffect(effect, on, seconds, value) {
    const key = normalizeAssetKey(effect);
    if (!key) return;
    this.state.screenEffects[key] = { effect, on, seconds, value };
    const duration = Math.max(0, Number(seconds) || 0);
    el.screenEffectLayer.style.transitionDuration = `${duration * 1000}ms`;
    const active = Object.values(this.state.screenEffects).filter((item) => item.on);
    el.screenEffectLayer.dataset.effects = active.map((item) => item.effect).join(',');
    const filters = active.map((item) => screenEffectFilter(item.effect, item.value)).filter(Boolean);
    el.screenEffectLayer.style.filter = filters.join(' ');
    if (!active.length && !this.state.colorFade) el.screenEffectLayer.style.opacity = '0';
  }

  captureTransitionCrossFade() {
    this.transitionSnapshot = buildTransitionSnapshot();
    this.state.transitionCapture = { capturedAt: performance.now() };
  }

  transitionCrossFade(transitionName, seconds) {
    const duration = Math.max(0, Number(seconds) || 0);
    const snapshot = this.transitionSnapshot || buildTransitionSnapshot();
    this.state.transition = { name: transitionName || '', seconds: duration };
    if (this.transitionTimer) clearTimeout(this.transitionTimer);
    if (this.crossFadeTimer) {
      clearTimeout(this.crossFadeTimer);
      this.crossFadeTimer = 0;
    }
    this.state.crossFade = null;
    el.transitionLayer.replaceChildren(snapshot);
    el.transitionLayer.dataset.effect = 'transition-crossfade';
    el.transitionLayer.style.display = 'block';
    el.transitionLayer.style.opacity = '1';
    el.transitionLayer.style.transform = '';
    el.transitionLayer.style.transformOrigin = '';
    el.transitionLayer.style.transitionProperty = 'opacity';
    el.transitionLayer.style.transitionTimingFunction = 'linear';
    el.transitionLayer.style.transitionDuration = '0ms';

    if (duration <= 0) {
      this.clearTransitionCrossFade();
      return;
    }

    requestAnimationFrame(() => {
      el.transitionLayer.style.transitionDuration = `${duration * 1000}ms`;
      el.transitionLayer.style.opacity = '0';
    });
    this.transitionTimer = setTimeout(() => this.clearTransitionCrossFade(), (duration * 1000) + 80);
  }

  transitionFade(ruleName, direction, colorName, seconds) {
    const duration = Math.max(0, Number(seconds) || 0);
    const fadeIn = normalizeAssetKey(direction) === 'in';
    const white = normalizeAssetKey(colorName) === 'white';
    const color = white ? '#fff' : '#000';
    this.state.transitionFade = { ruleName: ruleName || '', direction, colorName, seconds: duration };
    el.fadeLayer.style.background = color;
    el.fadeLayer.style.transitionDuration = '0ms';
    if (fadeIn) el.fadeLayer.style.opacity = '1';
    requestAnimationFrame(() => {
      el.fadeLayer.style.transitionDuration = `${duration * 1000}ms`;
      el.fadeLayer.style.opacity = fadeIn ? '0' : '1';
    });
    if (fadeIn && duration > 0) {
      window.setTimeout(() => {
        if (this.state.transitionFade?.ruleName === (ruleName || '') && normalizeAssetKey(this.state.transitionFade.direction) === 'in') {
          el.fadeLayer.style.transitionDuration = '0ms';
          el.fadeLayer.style.opacity = '0';
        }
      }, (duration * 1000) + 80);
    }
  }

  clearTransitionCrossFade() {
    if (this.transitionTimer) clearTimeout(this.transitionTimer);
    this.transitionTimer = 0;
    this.state.transition = null;
    this.transitionSnapshot = null;
    if (el.transitionLayer.dataset.effect !== 'transition-crossfade') return;
    el.transitionLayer.replaceChildren();
    el.transitionLayer.style.display = 'none';
    el.transitionLayer.style.opacity = '0';
    el.transitionLayer.style.transform = '';
    el.transitionLayer.style.transformOrigin = '';
    el.transitionLayer.style.transitionProperty = 'opacity';
    el.transitionLayer.style.transitionDuration = '0ms';
    el.transitionLayer.dataset.effect = '';
  }

  clearSkipArtifacts() {
    this.state.linework = null;
    this.clearCrossFade();
    this.clearTransitionCrossFade();
  }

  blur(on, target, seconds) {
    const normalizedTarget = normalizeAssetKey(target || 'SCREEN');
    const layers = screenBlurTargetLayers(normalizedTarget);
    this.state.blur = { on, target: target || '', seconds };
    for (const layer of layers) {
      layer.style.transition = `filter ${Math.max(0, seconds) * 1000}ms linear`;
      layer.style.filter = on ? 'blur(5px)' : '';
    }
  }
}

class NovelModelScene {
  constructor() {
    this.assetCache = new Map();
    this.reset();
  }

  reset() {
    this.state = {
      characters: {},
      objects: {},
      prefabs: {},
      backgrounds: {},
      subimages: {},
      stills: {},
      background: null,
      backgroundTransform: { x: 0, y: 0, scaleX: 1, scaleY: 1, seconds: 0, easing: 'linear' },
      backgroundColor: { r: 0, g: 0, b: 0, alpha: 0, seconds: 0 },
      camera: { x: 0, y: 0, zoom: 1, seconds: 0, easing: 'linear' },
    };
    el.sceneLayer.replaceChildren();
    this.clearBackground();
    this.applyLayerTransforms();
  }

  target(bucketName, tag) {
    const bucket = this.state[bucketName];
    const key = tag || 'default';
    bucket[key] = bucket[key] || {
      tag: key,
      visible: false,
      deleted: false,
      alpha: 0,
      x: 0,
      y: 0,
      charaHeight: 0,
      scale: 1,
      transitionSeconds: 0,
      easing: 'linear',
      rotation: 0,
      priority: 0,
      layer: '',
      frontBack: '',
    };
    return bucket[key];
  }

  async loadCharacter(tag, characterId, displayName) {
    const target = this.target('characters', tag);
    const id = String(characterId || '').toUpperCase();
    target.kind = 'character';
    target.characterId = id;
    target.displayName = displayName || '';
    target.assetBase = `${CHARA_DATA_ROOT}${id.toLowerCase()}/`;
    target.asset = await this.loadCharacterAsset(id);
    target.loaded = !!target.asset?.files?.body;
    target.deleted = false;
    target.visible = target.visible === true;
    target.alpha = Number.isFinite(target.alpha) ? target.alpha : 0;
    target.baseFace = target.baseFace || 'normal';
    target.eyeClosed = !!target.eyeClosed;
    target.transitionSeconds = 0;
    return target;
  }

  async loadCharacterAsset(characterId) {
    const key = String(characterId || '').toLowerCase();
    if (!key) return null;
    if (!this.assetCache.has(key)) {
      this.assetCache.set(key, fetchJson(`${CHARA_DATA_ROOT}${key}/meta.json`).catch((error) => {
        setStatus(`chara asset missing: ${characterId} (${error.message})`, true);
        return null;
      }));
    }
    return this.assetCache.get(key);
  }

  faceCharacter(tag, faceName) {
    const target = this.target('characters', tag);
    const normalized = normalizeCharaFace(faceName);
    target.lastFaceCommand = faceName;
    target.transitionSeconds = 0;
    if (normalized === 'closed') {
      target.eyeClosed = true;
      return;
    }
    if (normalized === 'eyeopen') {
      target.eyeClosed = false;
      return;
    }
    target.baseFace = normalized || 'normal';
  }

  poseCharacter(tag, pose) {
    const target = this.target('characters', tag);
    target.pose = Number(pose) || 0;
  }

  moveCharacter(tag, moveType, parameter, value, seconds) {
    const target = this.target('characters', tag);
    const resolved = resolveCharaMoveParameter(parameter, value, target);
    const move = resolveCharaMoveValue(moveType, resolved.value, resolved.axis === 'x' ? target.x : target.y);
    if (resolved.axis === 'x') target.x = move.value;
    if (resolved.axis === 'y') target.y = move.value;
    target.moveType = String(moveType || 'Set');
    target.moveParameter = String(parameter || '');
    target.transitionSeconds = move.instant ? 0 : Math.max(0, Number(seconds) || 0);
    target.easing = charaMoveEasing(moveType);
  }

  scaleCharacter(tag, scale, seconds) {
    const target = this.target('characters', tag);
    target.scale = clamp(Number(scale) || 1, 0.05, 5);
    target.transitionSeconds = Math.max(0, Number(seconds) || 0);
    target.easing = 'ease-out';
  }

  showCharacter(tag, seconds, alpha = 1) {
    const target = this.target('characters', tag);
    const value = Number(alpha);
    target.focus = true;
    target.visible = true;
    target.deleted = false;
    target.alpha = clamp(Number.isFinite(value) ? value : 1, 0, 1);
    target.transitionSeconds = Math.max(0, Number(seconds) || 0);
    target.easing = 'linear';
  }

  hideCharacter(tag, seconds) {
    const target = this.target('characters', tag);
    target.visible = false;
    target.alpha = 0;
    target.transitionSeconds = Math.max(0, Number(seconds) || 0);
    target.easing = 'linear';
  }

  deleteCharacter(tag) {
    const target = this.target('characters', tag);
    target.deleted = true;
    target.visible = false;
    target.alpha = 0;
  }

  emotionCharacter(tag, emotionName) {
    const target = this.target('characters', tag);
    target.emotion = normalizeAssetKey(emotionName);
    target.emotionRaw = emotionName || '';
    target.emotionNonce = (target.emotionNonce || 0) + 1;
    target.emotionStartedAt = performance.now();
    target.emotionDurationSeconds = emotionDurationSeconds(target.emotion);
    return target.emotionDurationSeconds;
  }

  clearEmotion(tag) {
    const target = this.target('characters', tag);
    target.emotion = '';
    target.emotionRaw = '';
    target.emotionDurationSeconds = 0;
  }

  focusAllCharacters() {
    this.setAllCharacterFocus(true);
  }

  setAllCharacterFocus(focused) {
    for (const item of Object.values(this.state.characters)) item.focus = !!focused;
  }

  focusCharacter(tag, focused) {
    const target = this.target('characters', tag);
    target.focus = !!focused;
  }

  maskCharacter(tag, start, end, seconds) {
    const target = this.target('characters', tag);
    target.mask = { start: Number(start) || 0, end: Number(end) || 0, seconds: Math.max(0, Number(seconds) || 0) };
    target.transitionSeconds = target.mask.seconds;
  }

  itemCharacter(tag, itemNo, alpha, beforeAlpha, seconds) {
    const target = this.target('characters', tag);
    target.item = {
      itemNo: Number(itemNo) || 0,
      alpha: Number(alpha) || 0,
      beforeAlpha: Number(beforeAlpha) || 0,
      seconds: Math.max(0, Number(seconds) || 0),
    };
    target.transitionSeconds = target.item.seconds;
  }

  setDefaultCharacterColor() {
    for (const item of Object.values(this.state.characters)) {
      item.color = null;
      item.focus = true;
    }
  }

  reactCharacter(tag, reactionName, seconds) {
    const target = this.target('characters', tag);
    target.reaction = normalizeAssetKey(reactionName);
    target.reactionSeconds = Math.max(0, Number(seconds) || 0);
    target.reactionNonce = (target.reactionNonce || 0) + 1;
  }

  setBackgroundColor(r, g, b, alpha, seconds) {
    this.state.backgroundColor = { r, g, b, alpha, seconds: Math.max(0, Number(seconds) || 0) };
    el.bgLayer.style.transition = `background-color ${this.state.backgroundColor.seconds * 1000}ms linear`;
    el.bgLayer.style.backgroundColor = rgbaByte(r, g, b, alpha);
  }

  setBackground(backgroundName, applyCharaColor = true) {
    const key = normalizeAssetKey(backgroundName);
    if (!key) return;
    if (!app.backgroundAssets.has(key)) {
      setStatus(`background asset missing: ${backgroundName}`, true);
      return;
    }
    this.state.background = { name: key, rawName: backgroundName, applyCharaColor };
    el.stage.dataset.background = key;
    el.bgLayer.dataset.background = key;
    el.bgLayer.style.opacity = '1';
    el.bgLayer.style.backgroundImage = `url("${BG_DATA_ROOT}${key}.png")`;
    this.verifyBackgroundImage(key);
  }

  clearBackground() {
    el.stage.dataset.background = '';
    el.bgLayer.dataset.background = '';
    el.bgLayer.style.opacity = '0';
    el.bgLayer.style.backgroundImage = '';
    el.bgLayer.style.filter = '';
    el.bgLayer.style.backgroundColor = 'rgba(0,0,0,0)';
  }

  moveCamera(easing, axis, value, seconds) {
    const moveType = normalizeCharaMoveType(easing);
    const key = normalizeAssetKey(axis);
    const nextValue = Number(value) || 0;
    this.state.camera.seconds = Math.max(0, Number(seconds) || 0);
    this.state.camera.easing = easingToCss(easing);
    const applyAxis = (axisName) => {
      const current = Number(this.state.camera[axisName]) || 0;
      this.state.camera[axisName] = moveType === 'add' ? current + nextValue : nextValue;
    };
    if (['x', 'horizontal', 'left', 'right'].includes(key)) applyAxis('x');
    else if (['y', 'vertical', 'up', 'down', 'top', 'bottom'].includes(key)) applyAxis('y');
    else {
      applyAxis('x');
      applyAxis('y');
    }
    this.applyLayerTransforms();
  }

  zoomCamera(zoom, seconds, easing) {
    const moveType = normalizeCharaMoveType(easing);
    const value = Number(zoom) || 1;
    const current = Number(this.state.camera.zoom) || 1;
    this.state.camera.zoom = clamp(moveType === 'add' ? current + value : value, 0.05, 8);
    this.state.camera.seconds = Math.max(0, Number(seconds) || 0);
    this.state.camera.easing = easingToCss(easing);
    this.applyLayerTransforms();
  }

  moveTarget(targetType, tag, seconds, x, y, easing) {
    const type = normalizeTargetType(targetType);
    const duration = Math.max(0, Number(seconds) || 0);
    const tx = Number(x) || 0;
    const ty = Number(y) || 0;
    const cssEasing = easingToCss(easing);
    if (type === 'back') {
      this.state.backgroundTransform.x = -tx;
      this.state.backgroundTransform.y = ty;
      this.state.backgroundTransform.seconds = duration;
      this.state.backgroundTransform.easing = cssEasing;
      this.applyLayerTransforms();
      return;
    }
    const item = this.sceneTargetForType(type, tag);
    item.x = tx;
    item.y = ty;
    item.transitionSeconds = duration;
    item.easing = cssEasing;
    item.visible = true;
  }

  scaleTarget(targetType, tag, seconds, scaleX, scaleY, easing) {
    const type = normalizeTargetType(targetType);
    const duration = Math.max(0, Number(seconds) || 0);
    const sx = Number.isFinite(Number(scaleX)) ? Number(scaleX) : 1;
    const sy = Number.isFinite(Number(scaleY)) ? Number(scaleY) : sx;
    const cssEasing = easingToCss(easing);
    if (type === 'back') {
      this.state.backgroundTransform.scaleX = sx;
      this.state.backgroundTransform.scaleY = sy;
      this.state.backgroundTransform.seconds = duration;
      this.state.backgroundTransform.easing = cssEasing;
      this.applyLayerTransforms();
      return;
    }
    const item = this.sceneTargetForType(type, tag);
    item.scaleX = sx;
    item.scaleY = sy;
    item.scale = sx;
    item.transitionSeconds = duration;
    item.easing = cssEasing;
    item.visible = true;
  }

  colorCharacter(tag, seconds, r, g, b, alpha) {
    const target = this.target('characters', tag);
    target.color = { r, g, b, alpha };
    target.transitionSeconds = Math.max(0, Number(seconds) || 0);
  }

  createSubImage(asset, tag, alpha, layer, layerId, layerPosTag, layerTargetObject) {
    const target = this.target('subimages', tag || asset || 'subimage');
    const assetText = String(asset || '');
    const imageInfo = resolveSceneAssetInfo(assetText);
    target.kind = 'subimage';
    target.asset = assetText;
    target.visible = true;
    target.deleted = false;
    target.x = 0;
    target.y = 0;
    target.scale = 1;
    target.scaleX = 1;
    target.scaleY = 1;
    target.layer = layer || '';
    target.layerId = Number(layerId) || 0;
    target.layerPosTag = layerPosTag || '';
    target.layerTargetObject = layerTargetObject || '';
    target.priority = Number(layerId) || target.priority || 0;
    target.alpha = normalizeAlpha(alpha);
    target.imageSrc = imageInfo.src;
    target.assetWidth = imageInfo.width;
    target.assetHeight = imageInfo.height;
    target.fullFrame = imageInfo.fullFrame;
  }

  fadeSubImage(tag, fromAlpha, toAlpha, seconds) {
    const target = this.target('subimages', tag);
    target.visible = true;
    target.deleted = false;
    target.alpha = normalizeAlpha(fromAlpha);
    target.transitionSeconds = 0;
    this.render();
    target.transitionSeconds = Math.max(0, Number(seconds) || 0);
    const finalAlpha = normalizeAlpha(toAlpha);
    target.alpha = finalAlpha;
    if (finalAlpha <= 0) {
      window.setTimeout(() => {
        if (target.alpha <= 0 && !target.deleted) {
          target.visible = false;
          this.render();
        }
      }, target.transitionSeconds * 1000);
    }
  }

  deleteSubImage(tag) {
    const target = this.target('subimages', tag);
    target.deleted = true;
    target.visible = false;
    target.alpha = 0;
  }

  loadStill(tag, asset) {
    const target = this.target('stills', tag || asset || 'still');
    const assetText = String(asset || '');
    const imageInfo = resolveSceneAssetInfo(assetText);
    target.kind = 'still';
    target.asset = assetText;
    target.deleted = false;
    target.visible = false;
    target.alpha = 0;
    target.x = 0;
    target.y = 0;
    target.scale = 1;
    target.priority = 30;
    target.stillIndex = 1;
    target.imageSrc = imageInfo.src;
    target.assetWidth = imageInfo.width;
    target.assetHeight = imageInfo.height;
    target.fullFrame = true;
  }

  changeStill(tag, index) {
    const target = this.target('stills', tag);
    target.kind = 'still';
    target.stillIndex = Number.isFinite(Number(index)) ? Math.trunc(Number(index)) : 1;
    if (!target.asset) target.asset = tag || 'still';
    if (!target.imageSrc) {
      const imageInfo = resolveSceneAssetInfo(target.asset);
      target.imageSrc = imageInfo.src;
      target.assetWidth = imageInfo.width;
      target.assetHeight = imageInfo.height;
      target.fullFrame = true;
    }
  }

  fadeStill(tag, visible, seconds) {
    const target = this.target('stills', tag);
    target.kind = 'still';
    target.deleted = false;
    target.visible = true;
    target.transitionSeconds = Math.max(0, Number(seconds) || 0);
    target.alpha = visible ? 1 : 0;
    if (!visible) {
      window.setTimeout(() => {
        if (target.alpha === 0) {
          target.visible = false;
          this.render();
        }
      }, target.transitionSeconds * 1000);
    }
  }

  deleteStill(tag) {
    const target = this.target('stills', tag);
    target.deleted = true;
    target.visible = false;
    target.alpha = 0;
  }

  loadPrefabUi(tag, asset, targetType, x, layer, option) {
    const target = this.target('prefabs', tag || asset || 'prefab');
    target.kind = 'prefab';
    target.asset = asset || '';
    target.targetType = targetType || '';
    target.x = Number(x) || 0;
    target.y = 0;
    target.layer = layer || '';
    target.option = option || '';
    target.visible = false;
    target.alpha = 0;
  }

  loadPrefab(tag, asset, targetType, x, layer, option) {
    const target = this.target('prefabs', tag || asset || 'prefab');
    target.kind = 'prefab';
    target.asset = asset || '';
    target.targetType = targetType || '';
    target.x = Number(x) || 0;
    target.y = 0;
    target.layer = layer || '';
    target.option = option || '';
    target.visible = false;
    target.alpha = 0;
  }

  showPrefab(tag, on, seconds, x, y, option) {
    const target = this.target('prefabs', tag || 'prefab');
    target.kind = 'prefab';
    target.visible = !!on;
    target.alpha = on ? 1 : 0;
    target.x = Number.isFinite(Number(x)) ? Number(x) : target.x || 0;
    target.y = Number.isFinite(Number(y)) ? Number(y) : target.y || 0;
    target.option = option || target.option || '';
    target.transitionSeconds = Math.max(0, Number(seconds) || 0);
  }

  showPrefabUi(tag, on, seconds, x, y) {
    const target = this.target('prefabs', tag || 'prefab');
    target.visible = !!on;
    target.alpha = on ? 1 : 0;
    target.x = Number.isFinite(Number(x)) ? Number(x) : target.x || 0;
    target.y = Number.isFinite(Number(y)) ? Number(y) : target.y || 0;
    target.transitionSeconds = Math.max(0, Number(seconds) || 0);
  }

  showPrefabAll(tag, asset, on, seconds, x, option) {
    const target = this.target('prefabs', tag || asset || 'prefaball');
    target.kind = 'prefaball';
    target.asset = asset || target.asset || '';
    target.visible = !!on;
    target.alpha = on ? 1 : 0;
    target.x = Number.isFinite(Number(x)) ? Number(x) : target.x || 0;
    target.option = option || target.option || '';
    target.transitionSeconds = Math.max(0, Number(seconds) || 0);
  }

  deletePrefabUi(tag) {
    const target = this.target('prefabs', tag);
    target.deleted = true;
    target.visible = false;
    target.alpha = 0;
  }

  deletePrefab(tag) {
    const target = this.target('prefabs', tag);
    target.deleted = true;
    target.visible = false;
    target.alpha = 0;
  }

  deletePrefabAll() {
    for (const target of Object.values(this.state.prefabs)) {
      target.deleted = true;
      target.visible = false;
      target.alpha = 0;
    }
  }

  setPriority(tag, targetType, priority, frontBack, group) {
    const type = normalizeTargetType(targetType);
    const item = this.sceneTargetForType(type, tag);
    item.priority = Number(priority) || 0;
    item.frontBack = frontBack || '';
    item.group = group || '';
  }

  showItem(on, itemId) {
    const target = this.target('objects', `item:${itemId || 'item'}`);
    target.kind = 'item';
    target.asset = String(itemId || '');
    target.visible = !!on;
    target.alpha = on ? 1 : 0;
  }

  shakeAll(x, y, z, count, seconds, random, value, loop) {
    this.applyShakeToElement(el.stage, 'shakeall', { x, y, z, count, seconds, random, value, loop });
  }

  stopShakeAll() {
    el.stage.getAnimations().forEach((animation) => {
      if (animation.effect?.target === el.stage) animation.cancel();
    });
  }

  shakeTarget(targetType, tag, x, y, seconds, count, random, loop, value) {
    const type = normalizeTargetType(targetType);
    if (type === 'back') {
      this.applyShakeToElement(el.bgLayer, `shake:${type}`, { x, y, count, seconds, random, loop, value });
      return;
    }
    const item = this.sceneTargetForType(type, tag);
    item.shake = { x, y, seconds, count, random, loop, value, nonce: (item.shake?.nonce || 0) + 1 };
  }

  jumpTarget(targetType, tag, power, seconds, count, loop) {
    const item = this.sceneTargetForType(normalizeTargetType(targetType), tag);
    item.jump = {
      power: Number(power) || 0,
      seconds: Math.max(0.001, Number(seconds) || 1),
      count: Math.max(1, Number(count) || 1),
      loop: Boolean(loop),
      nonce: (item.jump?.nonce || 0) + 1,
    };
  }

  stopJumpTarget(targetType, tag) {
    const item = this.sceneTargetForType(normalizeTargetType(targetType), tag);
    item.jump = { ...(item.jump || {}), stopNonce: (item.jump?.stopNonce || 0) + 1 };
    const key = item.loaded ? `character:${item.tag}` : `token:${item.tag}`;
    const node = el.sceneLayer.querySelector(`[data-scene-key="${cssEscape(key)}"]`);
    if (node) this.cancelAnimationById(node, `jump:${item.tag}`);
  }

  applyShakeToElement(node, id, options) {
    const duration = Math.max(0.001, Number(options.seconds) || 1) * 1000;
    const iterations = options.loop ? Infinity : Math.max(1, Number(options.count) || 1);
    const x = Number(options.x) || 0;
    const y = Number(options.y) || 0;
    this.cancelAnimationById(node, id);
    const animation = node.animate([
      { transform: node.style.transform || 'translate(0, 0)' },
      { transform: `${node.style.transform || ''} translate(${x}px, ${-y}px)` },
      { transform: `${node.style.transform || ''} translate(${-x}px, ${y}px)` },
      { transform: node.style.transform || 'translate(0, 0)' },
    ], { duration, iterations, easing: 'linear' });
    animation.id = id;
  }

  applyJumpToElement(node, item, unitScale) {
    if (item.jump?.stopNonce && node.dataset.jumpStopNonce !== String(item.jump.stopNonce)) {
      node.dataset.jumpStopNonce = String(item.jump.stopNonce);
      this.cancelAnimationById(node, `jump:${item.tag}`);
    }
    if (!item.jump?.nonce || node.dataset.jumpNonce === String(item.jump.nonce)) return;
    node.dataset.jumpNonce = String(item.jump.nonce);
    const id = `jump:${item.tag}`;
    this.cancelAnimationById(node, id);
    const baseTransform = node.style.transform || 'translate(-50%, -50%)';
    const power = Number(item.jump.power) || 0;
    const offset = -power * unitScale;
    const duration = Math.max(0.001, Number(item.jump.seconds) || 1) * 1000;
    const iterations = item.jump.loop ? Infinity : Math.max(1, Number(item.jump.count) || 1);
    const animation = node.animate([
      { transform: baseTransform },
      { transform: `${baseTransform} translateY(${offset}px)` },
      { transform: baseTransform },
    ], { duration, iterations, easing: 'ease-in-out' });
    animation.id = id;
  }

  cancelAnimationById(node, id) {
    node.getAnimations().forEach((animation) => {
      if (animation.id === id) animation.cancel();
    });
  }

  sceneTargetForType(type, tag) {
    if (type === 'subimage') return this.target('subimages', tag || 'subimage');
    if (type === 'prefab' || type === 'prefabui') return this.target('prefabs', tag || 'prefab');
    if (type === 'chara' || type === 'character') return this.target('characters', tag || 'chara');
    return this.target('objects', tag || type || 'object');
  }

  applyLayerTransforms() {
    const rect = el.stage.getBoundingClientRect();
    const unitScale = Math.max(0.01, (rect.height || 1) / 2048);
    const camera = this.state.camera || {};
    const bg = this.state.backgroundTransform || {};
    const cameraTransform = `translate(${-Number(camera.x || 0) * unitScale}px, ${Number(camera.y || 0) * unitScale}px) scale(${Number(camera.zoom) || 1})`;
    const cameraTransition = `transform ${Math.max(0, Number(camera.seconds) || 0) * 1000}ms ${camera.easing || 'linear'}`;
    for (const layer of [el.live2dCanvas, el.mosaicLayer, el.fallbackTexture, el.sceneLayer]) {
      layer.style.transition = mergeTransition(layer.style.transition, cameraTransition);
      layer.style.transformOrigin = '50% 50%';
      layer.style.transform = cameraTransform;
    }
    const bgTransform = `${cameraTransform} translate(${Number(bg.x || 0) * unitScale}px, ${-Number(bg.y || 0) * unitScale}px) scale(${Number(bg.scaleX) || 1}, ${Number(bg.scaleY) || 1})`;
    const bgTransition = `transform ${Math.max(0, Number(bg.seconds || camera.seconds) || 0) * 1000}ms ${bg.easing || camera.easing || 'linear'}`;
    el.bgLayer.style.transition = mergeTransition(el.bgLayer.style.transition, bgTransition);
    el.bgLayer.style.transformOrigin = '50% 50%';
    el.bgLayer.style.transform = bgTransform;
  }

  verifyBackgroundImage(backgroundName) {
    const image = new Image();
    image.onerror = () => setStatus(`background asset missing: ${backgroundName}`, true);
    image.src = `${BG_DATA_ROOT}${backgroundName}.png`;
  }

  render() {
    const activeKeys = new Set();
    const stageRect = el.stage.getBoundingClientRect();
    const unitScale = Math.max(0.01, (stageRect.height || 1) / 2048);
    this.applyLayerTransforms();

    Object.values(this.state.characters).forEach((item, index) => {
      if (item.deleted || !item.loaded) return;
      this.renderCharacter(item, index, stageRect, unitScale, activeKeys);
    });

    [
      ...Object.values(this.state.objects),
      ...Object.values(this.state.stills),
      ...Object.values(this.state.subimages),
      ...Object.values(this.state.prefabs),
    ].filter((item) => item.visible !== false && !item.deleted).forEach((item) => {
      this.renderToken(item, activeKeys, stageRect, unitScale);
    });

    for (const child of Array.from(el.sceneLayer.children)) {
      if (!activeKeys.has(child.dataset.sceneKey)) child.remove();
    }
  }

  renderToken(item, activeKeys, stageRect, unitScale) {
    const key = `token:${item.kind || 'scene'}:${item.tag}`;
    activeKeys.add(key);
    let node = el.sceneLayer.querySelector(`[data-scene-key="${cssEscape(key)}"]`);
    if (!node) {
      node = document.createElement('div');
      node.className = 'scene-token';
      node.dataset.sceneKey = key;
      el.sceneLayer.appendChild(node);
    }
    const x = (stageRect.width || 1) * 0.5 + (Number(item.x) || 0) * unitScale;
    const y = (stageRect.height || 1) * 0.5 - (Number(item.y) || 0) * unitScale;
    const scale = clamp(Number(item.scale) || 1, .2, 4);
    node.title = item.tag;
    node.classList.toggle('image-token', !!item.imageSrc);
    node.classList.toggle('full-frame-token', !!item.fullFrame);
    if (item.imageSrc && !item.fullFrame) {
      const baseWidth = Math.max(1, Number(item.assetWidth) || 320);
      const baseHeight = Math.max(1, Number(item.assetHeight) || 180);
      node.style.width = `${baseWidth * unitScale}px`;
      node.style.height = `${baseHeight * unitScale}px`;
    } else {
      node.style.width = '';
      node.style.height = '';
    }
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    node.style.opacity = String(clamp(Number(item.alpha ?? 1), 0, 1));
    node.style.zIndex = String(80 + (Number(item.priority) || 0));
    node.style.transitionDuration = `${Math.max(0, Number(item.transitionSeconds) || 0) * 1000}ms`;
    node.style.transitionTimingFunction = item.easing || 'linear';
    node.style.backgroundImage = item.imageSrc ? `url("${item.imageSrc}")` : '';
    node.textContent = item.imageSrc ? '' : (item.stillIndex ? `${item.asset || item.tag || ''} #${item.stillIndex}` : (item.asset || item.tag || ''));
    node.style.transform = `translate(-50%, -50%) scale(${Number(item.scaleX) || scale}, ${Number(item.scaleY) || scale}) rotate(${Number(item.rotation) || 0}deg)`;
    if (item.shake?.nonce && node.dataset.shakeNonce !== String(item.shake.nonce)) {
      node.dataset.shakeNonce = String(item.shake.nonce);
      this.applyShakeToElement(node, `shake:${item.tag}`, item.shake);
    }
    this.applyJumpToElement(node, item, unitScale);
  }

  renderCharacter(item, index, stageRect, unitScale, activeKeys) {
    const key = `character:${item.tag}`;
    activeKeys.add(key);
    let node = el.sceneLayer.querySelector(`[data-scene-key="${cssEscape(key)}"]`);
    if (!node) {
      node = document.createElement('div');
      node.className = 'scene-character';
      node.dataset.sceneKey = key;
      node.innerHTML = `
        <div class="scene-character-body">
          <img class="scene-character-body-image" alt="">
          <img class="scene-character-face-image" alt="">
        </div>
        <div class="scene-character-emotion"></div>
      `;
      el.sceneLayer.appendChild(node);
    }

    const rootRect = item.asset.rootRect || {};
    const rootSize = rectSize(rootRect, 2048, 2048);
    const rootWidth = rootSize.x * unitScale;
    const rootHeight = rootSize.y * unitScale;
    const stageCenterX = (stageRect.width || 1) * 0.5;
    const stageCenterY = (stageRect.height || 1) * 0.5;
    const finalX = stageCenterX + (Number(item.x) || 0) * unitScale;
    const finalY = stageCenterY - (Number(item.y) || 0) * unitScale;
    const seconds = Math.max(0, Number(item.transitionSeconds) || 0);
    const timing = item.easing || 'linear';
    const alpha = item.visible === false ? 0 : clamp(Number(item.alpha) || 0, 0, 1);

    node.dataset.characterId = item.characterId || '';
    node.dataset.face = currentCharaFaceKey(item);
    node.dataset.emotion = item.emotion || '';
    node.style.width = `${rootWidth}px`;
    node.style.height = `${rootHeight}px`;
    node.style.left = `${finalX}px`;
    node.style.top = `${finalY}px`;
    node.style.opacity = String(alpha);
    node.style.zIndex = String(40 + index);
    node.style.filter = characterFilter(item);
    node.style.transitionDuration = `${seconds * 1000}ms`;
    node.style.transitionTimingFunction = timing;
    node.style.transform = `translate(-50%, -50%) scale(${clamp(Number(item.scale) || 1, 0.05, 5)})`;

    this.renderCharacterBody(node, item, unitScale);
    this.renderCharacterEmotion(node, item, unitScale);
    this.applyCharacterReaction(node, item);
    this.applyJumpToElement(node, item, unitScale);
  }

  renderCharacterBody(node, item, unitScale) {
    const body = node.querySelector('.scene-character-body');
    const bodyImage = node.querySelector('.scene-character-body-image');
    const faceImage = node.querySelector('.scene-character-face-image');
    const bodyRect = item.asset.bodyRect || {};
    const faceRect = item.asset.faceContentRect || {};
    const bodySize = rectSize(bodyRect, 1024, 1600);
    const bodyPosition = rectPosition(bodyRect);
    const bodyScale = rectScale(bodyRect, 1);
    const bodyPivot = rectPivot(bodyRect);
    const bodyWidth = bodySize.x * unitScale;
    const bodyHeight = bodySize.y * unitScale;

    body.style.width = `${bodyWidth}px`;
    body.style.height = `${bodyHeight}px`;
    body.style.left = `calc(50% + ${bodyPosition.x * unitScale}px)`;
    body.style.top = `calc(50% + ${-bodyPosition.y * unitScale}px)`;
    body.style.transform = `translate(${-bodyPivot.x * 100}%, ${-(1 - bodyPivot.y) * 100}%) scale(${bodyScale.x}, ${bodyScale.y})`;

    const bodySrc = `${item.assetBase}${item.asset.files.body}`;
    if (bodyImage.dataset.src !== bodySrc) {
      bodyImage.src = bodySrc;
      bodyImage.dataset.src = bodySrc;
    }

    const faceSrc = this.characterFaceUrl(item);
    if (faceSrc) {
      const faceSize = rectSize(faceRect, 256, 256);
      const facePosition = rectPosition(faceRect);
      faceImage.hidden = false;
      faceImage.style.width = `${faceSize.x * unitScale}px`;
      faceImage.style.height = `${faceSize.y * unitScale}px`;
      faceImage.style.left = `calc(50% + ${facePosition.x * unitScale}px)`;
      faceImage.style.top = `calc(50% + ${-facePosition.y * unitScale}px)`;
      if (faceImage.dataset.src !== faceSrc) {
        faceImage.src = faceSrc;
        faceImage.dataset.src = faceSrc;
      }
    } else {
      faceImage.hidden = true;
      faceImage.removeAttribute('src');
      faceImage.dataset.src = '';
    }
  }

  renderCharacterEmotion(node, item, unitScale) {
    const emotionNode = node.querySelector('.scene-character-emotion');
    const emotion = normalizeAssetKey(item.emotion);
    if (!emotion) {
      emotionNode.hidden = true;
      emotionNode.replaceChildren();
      emotionNode.dataset.emotion = '';
      return;
    }

    const asset = app.emotionAssets.get(emotion);
    const emotionRect = item.asset.emotionRect || {};
    const attachment = emotionAttachmentTransform(item.asset);
    const prefabRootRect = asset?.rootRect || {};
    const prefabRootPosition = rectPosition(prefabRootRect);
    const prefabRootScale = rectScale(prefabRootRect, 1);
    const position = {
      x: attachment.position.x + prefabRootPosition.x,
      y: attachment.position.y + prefabRootPosition.y,
    };
    const scale = {
      x: attachment.scale.x * prefabRootScale.x,
      y: attachment.scale.y * prefabRootScale.y,
    };
    const pivot = rectPivot(prefabRootRect);
    const rootSize = rectSize(asset?.rootRect || emotionRect, 150, 150);
    emotionNode.hidden = false;
    emotionNode.dataset.emotion = emotion;
    emotionNode.dataset.nonce = String(item.emotionNonce || 0);
    emotionNode.style.width = `${rootSize.x * unitScale}px`;
    emotionNode.style.height = `${rootSize.y * unitScale}px`;
    emotionNode.style.left = `calc(50% + ${position.x * unitScale}px)`;
    emotionNode.style.top = `calc(50% + ${-position.y * unitScale}px)`;
    emotionNode.style.transform = `translate(${-pivot.x * 100}%, ${-(1 - pivot.y) * 100}%) scale(${scale.x}, ${scale.y})`;

    if (asset?.parts?.length) {
      if (emotionNode.dataset.renderKey !== `${emotion}:${asset.parts.length}`) {
        emotionNode.replaceChildren(...asset.parts.map((part, index) => createEmotionPart(part, index)));
        emotionNode.dataset.renderKey = `${emotion}:${asset.parts.length}`;
      }
      for (const child of Array.from(emotionNode.children)) {
        const part = asset.parts[Number(child.dataset.partIndex) || 0];
        applyEmotionPartLayout(child, part, unitScale);
      }
    } else {
      const fallbackSrc = `${CHARA_EMOTION_ROOT}${emotion}.png`;
      if (emotionNode.dataset.renderKey !== `${emotion}:fallback`) {
        const image = document.createElement('img');
        image.className = 'scene-character-emotion-part';
        image.alt = '';
        image.dataset.partIndex = '0';
        emotionNode.replaceChildren(image);
        emotionNode.dataset.renderKey = `${emotion}:fallback`;
      }
      const image = emotionNode.firstElementChild;
      const fallbackPart = {
        file: `${emotion}.png`,
        position: { x: 0, y: 0 },
        size: rootSize,
        pivot: { x: 0.5, y: 0.5 },
        localScale: { x: 1, y: 1 },
      };
      if (image.dataset.src !== fallbackSrc) {
        image.src = fallbackSrc;
        image.dataset.src = fallbackSrc;
      }
      applyEmotionPartLayout(image, fallbackPart, unitScale);
    }
  }

  applyCharacterReaction(node, item) {
    const nonce = String(item.reactionNonce || 0);
    if (!item.reaction || node.dataset.reactionNonce === nonce) return;
    node.dataset.reactionNonce = nonce;
    const seconds = Math.max(0.1, Number(item.reactionSeconds) || 1);
    const duration = seconds * 1000;
    if (item.reaction === 'jump') {
      node.animate([
        { transform: node.style.transform },
        { transform: `${node.style.transform} translateY(-34px)` },
        { transform: node.style.transform },
      ], { duration, easing: 'ease-out' });
    } else if (item.reaction === 'nod') {
      node.animate([
        { transform: node.style.transform },
        { transform: `${node.style.transform} translateY(18px)` },
        { transform: node.style.transform },
      ], { duration, easing: 'ease-in-out' });
    } else if (item.reaction === 'shake') {
      node.animate([
        { transform: `${node.style.transform} translateX(0)` },
        { transform: `${node.style.transform} translateX(-24px)` },
        { transform: `${node.style.transform} translateX(24px)` },
        { transform: `${node.style.transform} translateX(0)` },
      ], { duration, easing: 'ease-in-out' });
    }
  }

  characterFaceUrl(item) {
    const faces = item.asset?.faces || {};
    const faceKey = currentCharaFaceKey(item);
    const path = faces[faceKey] || faces[item.baseFace] || faces.normal || Object.values(faces)[0];
    return path ? `${item.assetBase}${path}` : '';
  }
}

class NovelModelSound {
  constructor() {
    this.elements = new Map();
    this.mediaSources = new WeakMap();
    this.voiceAnalysers = new Map();
    this.storyCues = {};
    this.globalCueSources = [];
    this.basePath = '';
    this.unlocked = false;
    this.blocked = false;
    this.audioContext = null;
    this.pendingVoices = new Map();
  }

  loadStory(story, basePath) {
    this.stopAll();
    this.storyCues = story.audio?.cues || {};
    this.globalCueSources = app.globalAudio?.sources || [];
    this.basePath = basePath;
    this.pendingVoices.clear();
  }

  unlock() {
    this.unlocked = true;
    this.blocked = false;
    try { this.ensureAudioContext()?.resume?.(); } catch (_) {}
    const currentVoice = app.controller?.message?.state?.voiceCue || '';
    for (const [key, audio] of this.elements.entries()) {
      if (!audio.src || !audio.paused) continue;
      const isLoop = audio.dataset.loop === 'true';
      const isCurrentVoice = key.startsWith('voice:') && audio.dataset.cue === currentVoice;
      if (isLoop || isCurrentVoice) {
        audio.dataset.status = 'prep';
        audio.play()
          .then(() => {
            if (!audio.paused && !audio.ended) audio.dataset.status = 'playing';
          })
          .catch((error) => {
            const blocked = error?.name === 'NotAllowedError';
            if (blocked) this.blocked = true;
            audio.dataset.status = blocked ? 'blocked' : (audio.error ? 'error' : 'prep');
          });
      }
    }
  }

  play(cueName, channel, tag, options = {}) {
    const resolved = this.resolveCue(cueName);
    if (!resolved) {
      if (cueName) setStatus(`missing cue: ${cueName}`, true);
      return;
    }
    const { cue, basePath } = resolved;
    const key = `${channel}:${tag || channel}`;
    let audio = this.elements.get(key);
    if (!audio) {
      audio = new Audio();
      audio.preload = 'auto';
      this.installAudioStateHandlers(audio);
      this.elements.set(key, audio);
    }
    audio.pause();
    audio.src = `${basePath}${cue.path}`;
    audio.dataset.fallbackSrc = cue.fallbackPath ? `${basePath}${cue.fallbackPath}` : '';
    const targetVolume = clamp(options.volume ?? 1, 0, 1);
    const fadeInSeconds = Math.max(0, Number(options.fadeInSeconds) || 0);
    audio.volume = fadeInSeconds > 0 ? 0 : targetVolume;
    audio.loop = Boolean(options.loop);
    audio.dataset.loop = String(audio.loop);
    audio.dataset.cue = cueName;
    audio.dataset.status = 'prep';
    audio.dataset.endedAt = '';
    audio.dataset.startedAt = String(performance.now());
    audio.dataset.triedFallback = 'false';
    audio.currentTime = 0;
    if (channel === 'voice') this.attachVoiceAnalyser(key, audio);
    try { this.audioContext?.resume?.(); } catch (_) {}
    audio.play().catch((error) => {
      const blocked = error?.name === 'NotAllowedError';
      if (blocked) this.blocked = true;
      audio.dataset.status = blocked ? 'blocked' : (audio.error ? 'error' : 'prep');
      if (blocked) setStatus('click to enable audio');
      else if (audio.error) setStatus(`${cueName}: ${error?.message || error}`, true);
    });
    if (fadeInSeconds > 0) fadeAudio(audio, targetVolume, fadeInSeconds);
    return audio;
  }

  queueVoice(cueName, enabled = true) {
    const cue = String(cueName || '');
    if (!cue) return;
    this.pendingVoices.set(cue, Boolean(enabled));
  }

  consumeMessageVoice(preferredCue = '') {
    const cue = String(preferredCue || '');
    if (cue) {
      if (this.pendingVoices.has(cue) && !this.pendingVoices.get(cue)) {
        this.pendingVoices.delete(cue);
        return '';
      }
      this.pendingVoices.delete(cue);
      return cue;
    }
    for (const [pendingCue, enabled] of this.pendingVoices.entries()) {
      this.pendingVoices.delete(pendingCue);
      if (enabled) return pendingCue;
    }
    return '';
  }

  preloadCue(cueName) {
    const resolved = this.resolveCue(cueName);
    if (!resolved) return false;
    const audio = new Audio();
    audio.preload = 'auto';
    audio.src = `${resolved.basePath}${resolved.cue.path}`;
    audio.load();
    return true;
  }

  resolveCue(cueName) {
    const exactName = String(cueName || '');
    const safeName = normalizeAudioCueKey(exactName);
    const storyCue = this.storyCues[exactName] || this.storyCues[safeName];
    if (storyCue) return { cue: storyCue, basePath: this.basePath };
    const sources = [...this.globalCueSources].sort((left, right) => {
      const leftCurrent = this.basePath.startsWith(left.basePath) ? 0 : 1;
      const rightCurrent = this.basePath.startsWith(right.basePath) ? 0 : 1;
      return leftCurrent - rightCurrent;
    });
    for (const source of sources) {
      const globalCue = source.cues?.[exactName] || source.cues?.[safeName];
      if (globalCue) return { cue: globalCue, basePath: source.basePath };
    }
    return null;
  }

  cueDuration(cueName) {
    const resolved = this.resolveCue(cueName);
    return Number(resolved?.cue?.duration) || 0;
  }

  installAudioStateHandlers(audio) {
    audio.addEventListener('playing', () => {
      audio.dataset.status = 'playing';
    });
    audio.addEventListener('waiting', () => {
      if (!audio.ended) audio.dataset.status = 'prep';
    });
    audio.addEventListener('stalled', () => {
      if (!audio.ended) audio.dataset.status = 'prep';
    });
    audio.addEventListener('ended', () => {
      audio.dataset.status = 'playend';
      audio.dataset.endedAt = String(performance.now());
    });
    audio.addEventListener('pause', () => {
      if (!audio.ended && audio.dataset.status !== 'prep' && audio.dataset.status !== 'blocked') {
        audio.dataset.status = 'stop';
      }
    });
    audio.addEventListener('error', () => {
      if (audio.dataset.fallbackSrc && audio.src !== audio.dataset.fallbackSrc && audio.dataset.triedFallback !== 'true') {
        audio.dataset.triedFallback = 'true';
        audio.src = audio.dataset.fallbackSrc;
        audio.load();
        audio.play().catch(() => {
          audio.dataset.status = 'error';
        });
        return;
      }
      audio.dataset.status = 'error';
    });
  }

  ensureAudioContext() {
    if (this.audioContext) return this.audioContext;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    this.audioContext = new AudioContextClass();
    return this.audioContext;
  }

  attachVoiceAnalyser(key, audio) {
    const context = this.ensureAudioContext();
    if (!context) return;
    let item = this.mediaSources.get(audio);
    if (!item) {
      const source = context.createMediaElementSource(audio);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.15;
      source.connect(analyser);
      analyser.connect(context.destination);
      item = {
        source,
        analyser,
        data: new Float32Array(analyser.frequencyBinCount),
        timeData: new Uint8Array(analyser.fftSize),
        audio,
      };
      this.mediaSources.set(audio, item);
    }
    this.voiceAnalysers.set(key, item);
  }

  currentVoiceAnalyser() {
    for (const [key, item] of this.voiceAnalysers.entries()) {
      if (!key.startsWith('voice:')) continue;
      if (item.audio?.src && !item.audio.paused && !item.audio.ended) return item;
    }
    return null;
  }

  currentVoiceTimeSeconds() {
    const item = this.currentVoiceAnalyser();
    return item?.audio ? item.audio.currentTime : 0;
  }

  currentVoiceLengthSeconds() {
    const item = this.currentVoiceAnalyser();
    if (!item?.audio) return 0;
    if (Number.isFinite(item.audio.duration)) return item.audio.duration;
    const cueName = item.audio.dataset.cue;
    return this.cueDuration(cueName);
  }

  currentVoiceMouthOpening() {
    const item = this.currentVoiceAnalyser();
    if (!item) return 0;
    item.analyser.getFloatFrequencyData(item.data);
    const sampleRate = this.audioContext?.sampleRate || 48000;
    const hzPerBin = sampleRate / Math.max(1, item.data.length);
    let low = 0;
    let mid = 0;
    let high = 0;
    for (let i = 0; i < item.data.length; i += 1) {
      const hz = hzPerBin * i;
      if (hz > L2D_LIP_SYNC.highFreqThreshold) break;
      const db = item.data[i];
      if (!Number.isFinite(db)) continue;
      const amplitude = Math.pow(10, db / 20);
      if (hz <= L2D_LIP_SYNC.lowFreqThreshold) low += amplitude;
      else if (hz <= L2D_LIP_SYNC.midFreqThreshold) mid += amplitude;
      else high += amplitude;
    }
    const value = ((low * L2D_LIP_SYNC.lowFreqEnhancer)
      + (mid * L2D_LIP_SYNC.midFreqEnhancer)
      + (high * L2D_LIP_SYNC.highFreqEnhancer)) / 3;
    return clamp(value / L2D_LIP_SYNC.maxMouthYSize, 0, 1);
  }

  fadeChannel(channel, tag, volume, seconds) {
    const targetVolume = clamp(volume, 0, 1);
    const duration = Math.max(0, Number(seconds) || 0);
    const tagText = String(tag || '');
    const keyPrefix = `${channel}:${tagText}`;
    const allTags = !tagText || tagText.toUpperCase() === 'ALL';
    for (const [key, audio] of this.elements.entries()) {
      if (allTags) {
        if (!key.startsWith(`${channel}:`)) continue;
      } else if (key !== keyPrefix) {
        continue;
      }
      fadeAudio(audio, targetVolume, duration, () => {
        if (targetVolume <= 0) {
          audio.pause();
          audio.currentTime = 0;
        }
      });
    }
  }

  fadeStop(channel, tag, seconds) {
    const keyPrefix = `${channel}:${tag || ''}`;
    for (const [key, audio] of this.elements.entries()) {
      if (tag && key !== keyPrefix) continue;
      if (!tag && !key.startsWith(`${channel}:`)) continue;
      fadeAudio(audio, 0, seconds, () => {
        audio.pause();
        audio.currentTime = 0;
      });
    }
  }

  stopVoiceAll() {
    this.fadeStop('voice', '', 0);
    this.voiceAnalysers.clear();
    this.pendingVoices.clear();
  }

  stopAll() {
    for (const audio of this.elements.values()) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    this.elements.clear();
    this.voiceAnalysers.clear();
    this.pendingVoices.clear();
  }

  currentLabels() {
    return Array.from(this.elements.entries())
      .filter(([, audio]) => audio.src && !audio.paused)
      .map(([key, audio]) => `${key}:${audio.dataset.cue || '?'}`);
  }

  isVoicePendingOrPlaying(cueName = '') {
    for (const [key, audio] of this.elements.entries()) {
      if (!key.startsWith('voice:')) continue;
      if (cueName && audio.dataset.cue !== cueName) continue;
      const status = audio.dataset.status || '';
      if (status === 'blocked' || status === 'error' || status === 'playend' || status === 'stop') continue;
      if (status === 'prep' || status === 'playing') return true;
      if (audio.src && !audio.ended && audio.readyState < HTMLMediaElement.HAVE_ENOUGH_DATA) return true;
      if (audio.src && !audio.ended && !audio.paused) return true;
    }
    return false;
  }

  voiceEndedAt(cueName = '') {
    let endedAt = 0;
    for (const [key, audio] of this.elements.entries()) {
      if (!key.startsWith('voice:')) continue;
      if (cueName && audio.dataset.cue !== cueName) continue;
      if (audio.dataset.status !== 'playend') continue;
      endedAt = Math.max(endedAt, Number(audio.dataset.endedAt) || 0);
    }
    return endedAt;
  }

  remainingVoiceMs(cueName = '') {
    let remaining = 0;
    for (const [key, audio] of this.elements.entries()) {
      if (!key.startsWith('voice:')) continue;
      if (cueName && audio.dataset.cue !== cueName) continue;
      if (!this.isVoicePendingOrPlaying(audio.dataset.cue || '')) continue;
      const cueDuration = this.cueDuration(audio.dataset.cue);
      const duration = Number.isFinite(audio.duration) ? audio.duration : cueDuration;
      if (duration > 0) remaining = Math.max(remaining, Math.max(0, duration - audio.currentTime) * 1000);
      else remaining = Math.max(remaining, AUTO_CHECK_MS);
    }
    return remaining;
  }
}

class NovelModelLive2D {
  constructor() {
    this.app = null;
    this.model = null;
    this.ready = false;
    this.visible = false;
    this.hasFallbackTexture = false;
    this.basePath = '';
    this.motionMap = new Map();
    this.groupParameterIds = new Map();
    this.motionGeneration = new Map();
    this.parameterLayers = new Map();
    this.lastMotionByGroup = new Map();
    this.heldParameters = new Map();
    this.holdFrame = 0;
    this.currentMotion = '';
    this.lipSync = null;
    this.lipSyncModeMulti = true;
    this.mosaicMode = 'original';
    this.mosaicDrawables = [];
    this.mosaicScratch = document.createElement('canvas');
    this.mosaicStatus = 'uninitialized';
    this.mosaicDrawPatchInstalled = false;
    this.naturalIdleActive = false;
    this.naturalIdleStarted = 0;
    this.naturalBlinkStart = L2D_NATURAL_IDLE.blinkIntervalSeconds * 0.45;
  }

  reset() {
    this.ready = false;
    this.visible = false;
    this.hasFallbackTexture = false;
    this.currentMotion = '';
    this.motionMap.clear();
    this.groupParameterIds.clear();
    this.motionGeneration.clear();
    this.parameterLayers.clear();
    this.lastMotionByGroup.clear();
    this.heldParameters.clear();
    this.lipSync = null;
    this.lipSyncModeMulti = true;
    this.mosaicDrawables = [];
    this.mosaicStatus = 'uninitialized';
    this.mosaicDrawPatchInstalled = false;
    this.naturalIdleActive = false;
    this.naturalIdleStarted = 0;
    this.naturalBlinkStart = L2D_NATURAL_IDLE.blinkIntervalSeconds * 0.45;
    this.clearMosaicOverlay();
    if (this.holdFrame) cancelAnimationFrame(this.holdFrame);
    this.holdFrame = 0;
    if (this.model) {
      try { this.app?.stage?.removeChild(this.model); } catch (_) {}
      try { this.model.destroy(); } catch (_) {}
    }
    this.model = null;
    el.motionBadge.textContent = '';
    el.fallbackTexture.classList.remove('visible');
    el.fallbackTexture.removeAttribute('src');
    el.fallbackTexture.dataset.src = '';
  }

  async loadStory(story, basePath) {
    this.basePath = basePath;
    this.buildMotionMap(story.live2d);
    await this.preloadMotionCurves();
    const fallback = story.live2d?.textures?.find((texture) => texture.name === 'texture_00') || story.live2d?.textures?.[0];
    if (fallback) {
      el.fallbackTexture.src = `${basePath}${fallback.path}`;
      el.fallbackTexture.dataset.src = el.fallbackTexture.src;
      this.hasFallbackTexture = true;
    }
    if (!story.live2d?.model3 || !window.PIXI?.live2d?.Live2DModel) {
      setStatus(this.hasFallbackTexture ? 'Live2D fallback texture' : '');
      return;
    }
    try {
      this.ensurePixi();
      this.model = await window.PIXI.live2d.Live2DModel.from(`${basePath}${story.live2d.model3}`);
      this.model.visible = false;
      this.model.autoInteract = false;
      this.disableSdkIdleMotion();
      this.disableSdkNaturalMotion();
      this.app.stage.addChild(this.model);
      this.ready = true;
      this.cacheMosaicDrawables();
      this.installMosaicDrawableSuppression();
      this.ensureParameterHoldLoop();
      this.fit();
      setStatus('Live2D ready');
    } catch (error) {
      setStatus(`Live2D fallback: ${error?.message || error}`, true);
    }
  }

  ensurePixi() {
    if (this.app) {
      this.app.renderer.resize(el.stage.clientWidth || 1, el.stage.clientHeight || 1);
      return;
    }
    this.app = new PIXI.Application({
      view: el.live2dCanvas,
      resizeTo: el.stage,
      backgroundAlpha: 0,
      antialias: true,
      preserveDrawingBuffer: true,
    });
  }

  buildMotionMap(live2d) {
    this.motionMap.clear();
    this.groupParameterIds.clear();
    for (const motion of live2d?.motions || []) {
      const entry = { ...motion, data: null };
      this.motionMap.set(normalizeKey(motion.name), entry);
      this.motionMap.set(normalizeKey(fileBase(motion.path)), entry);
    }
  }

  async preloadMotionCurves() {
    const unique = new Set(this.motionMap.values());
    await Promise.all(Array.from(unique, async (motion) => {
      if (!motion.path) return;
      try {
        motion.data = await fetchJson(`${this.basePath}${motion.path}`);
        this.registerMotionParameters(motion);
      } catch (error) {
        motion.data = null;
      }
    }));
  }

  registerMotionParameters(motion) {
    const group = motion.group || motion.name || 'default';
    if (!this.groupParameterIds.has(group)) this.groupParameterIds.set(group, new Set());
    const ids = this.groupParameterIds.get(group);
    for (const curve of motion.data?.Curves || []) {
      if (curve.Target === 'Parameter' && curve.Id) ids.add(curve.Id);
    }
  }

  show(asset) {
    this.visible = true;
    if (this.model) {
      this.model.visible = true;
      el.fallbackTexture.classList.remove('visible');
      this.fit();
      this.renderMosaicOverlay();
      this.startNaturalIdleMotion();
      if (!this.parameterLayers.has('Scene')) this.startDefaultIdleMotion();
    } else {
      el.fallbackTexture.classList.toggle('visible', this.hasFallbackTexture);
    }
    el.motionBadge.textContent = asset || LIVE2D_TAG;
  }

  async waitLoadComplete(token) {
    const started = performance.now();
    while (token === app.runToken && this.visible && !this.ready && !this.hasFallbackTexture && performance.now() - started < 8000) {
      await waitFrame();
    }
  }

  hide() {
    this.visible = false;
    if (this.model) this.model.visible = false;
    el.fallbackTexture.classList.remove('visible');
    el.motionBadge.textContent = 'Live2D hidden';
    this.stopLipSync();
    this.stopNaturalIdleMotion();
    this.clearMosaicOverlay();
  }

  setMosaicMode(mode) {
    this.mosaicMode = normalizeMosaicMode(mode);
    if (this.mosaicMode === 'off') {
      this.mosaicStatus = 'off';
      this.clearMosaicOverlay();
    } else {
      this.renderMosaicOverlay();
    }
  }

  setMosaicEnabled(enabled) {
    this.setMosaicMode(enabled ? 'original' : 'off');
  }

  playMotion(name, enabled = true, idle = false) {
    const motion = this.motionMap.get(normalizeKey(name));
    if (!idle) {
      this.currentMotion = name || '';
      el.motionBadge.textContent = name || '';
    }
    if (!this.model || !motion?.data) {
      if (this.resetMotionGroup(name)) return;
      if (!idle) pulseFallback();
      return;
    }
    this.startParameterMotion(motion);
  }

  isSceneMotionName(name) {
    const motion = this.motionMap.get(normalizeKey(name));
    return String(motion?.group || name || '').toLowerCase().startsWith('scene');
  }

  startDefaultIdleMotion() {
    if (!this.model) return;
    const idleMotion = this.findDefaultIdleMotion();
    if (idleMotion?.data) this.playMotion(idleMotion.name, true, true);
    else this.startNaturalIdleMotion();
  }

  findDefaultIdleMotion() {
    const motions = Array.from(new Set(this.motionMap.values()));
    return this.motionMap.get(normalizeKey(L2D_DEFAULT_IDLE_MOTION))
      || motions.find((motion) => motion.group === 'Idle')
      || motions.find((motion) => motion.group === 'Scene' && /_loop$/i.test(motion.name || ''))
      || null;
  }

  startParameterMotion(motion) {
    const group = motion.group || motion.name || 'default';
    const generation = (this.motionGeneration.get(group) || 0) + 1;
    this.motionGeneration.set(group, generation);
    const layer = this.ensureParameterLayer(group);

    const duration = Math.max(0.001, Number(motion.data?.Meta?.Duration ?? motion.duration ?? 0.5));
    const loop = Boolean(motion.data?.Meta?.Loop || motion.loop);
    const fadeIn = Math.max(0, Number(motion.fadeInTime ?? 0));
    const started = performance.now();
    const curves = (motion.data?.Curves || []).filter((curve) => curve.Target === 'Parameter');
    const curveIds = new Set(curves.map((curve) => curve.Id).filter(Boolean));
    const fadeFrom = new Map();
    for (const curve of curves) fadeFrom.set(curve.Id, this.composedParameterValue(curve.Id));
    for (const id of Array.from(layer.keys())) {
      if (!curveIds.has(id)) layer.delete(id);
    }
    this.lastMotionByGroup.set(group, motion);

    const tick = () => {
      if (!this.model || this.motionGeneration.get(group) !== generation) return;
      const elapsed = (performance.now() - started) / 1000;
      const time = loop ? elapsed % duration : Math.min(elapsed, duration);
      const fadeWeight = fadeIn > 0 ? smoothStep(clamp(elapsed / fadeIn, 0, 1)) : 1;
      for (const curve of curves) {
        const value = evaluateMotionCurve(curve.Segments, time);
        if (value == null) continue;
        const from = fadeFrom.get(curve.Id);
        layer.set(curve.Id, from == null ? value : lerp(from, value, fadeWeight));
      }
      this.applyHeldParameters();
      if (loop || elapsed < duration) requestAnimationFrame(tick);
      else this.startCompanionSceneLoop(motion, generation);
    };

    tick();
  }

  startCompanionSceneLoop(motion, generation) {
    const group = motion.group || motion.name || 'default';
    if (group !== 'Scene' || this.motionGeneration.get(group) !== generation) return;
    const baseName = motion.name || fileBase(motion.path);
    if (!baseName || /_loop$/i.test(baseName)) return;
    const loopMotion = this.motionMap.get(normalizeKey(`${baseName}_loop`));
    if (loopMotion?.data && loopMotion !== motion) this.startParameterMotion(loopMotion);
  }

  ensureParameterLayer(group) {
    if (!this.parameterLayers.has(group)) this.parameterLayers.set(group, new Map());
    return this.parameterLayers.get(group);
  }

  ensureParameterHoldLoop() {
    if (this.holdFrame) cancelAnimationFrame(this.holdFrame);
    const tick = () => {
      if (!this.model) {
        this.holdFrame = 0;
        return;
      }
      this.updateLipSync();
      this.updateNaturalIdleMotion();
      this.applyHeldParameters();
      this.renderMosaicOverlay();
      this.holdFrame = requestAnimationFrame(tick);
    };
    this.holdFrame = requestAnimationFrame(tick);
  }

  startNaturalIdleMotion() {
    if (!this.model || this.naturalIdleActive) return;
    this.naturalIdleActive = true;
    this.naturalIdleStarted = performance.now();
    this.naturalBlinkStart = L2D_NATURAL_IDLE.blinkIntervalSeconds * 0.45;
    this.ensureParameterLayer(L2D_NATURAL_IDLE.layer);
  }

  stopNaturalIdleMotion() {
    this.naturalIdleActive = false;
    this.parameterLayers.delete(L2D_NATURAL_IDLE.layer);
    if (this.model) this.applyHeldParameters();
  }

  updateNaturalIdleMotion() {
    if (!this.naturalIdleActive) return;
    if (!this.visible || !this.model) {
      this.stopNaturalIdleMotion();
      return;
    }

    const elapsed = Math.max(0, (performance.now() - this.naturalIdleStarted) / 1000);
    const layer = this.ensureParameterLayer(L2D_NATURAL_IDLE.layer);
    layer.clear();

    const tau = Math.PI * 2;
    const breath = 0.5 - Math.cos((elapsed / L2D_NATURAL_IDLE.breathSeconds) * tau) * 0.5;
    const body = Math.sin((elapsed / L2D_NATURAL_IDLE.bodySeconds) * tau);
    const hair = Math.sin((elapsed / L2D_NATURAL_IDLE.hairSeconds) * tau + 0.7);
    this.setNaturalIdleParameter(layer, 'ParamBreath', breath);
    this.setNaturalIdleParameter(layer, 'ParamManBreath', breath * 0.35);
    this.setNaturalIdleParameter(layer, 'ParamBodyMove', (breath - 0.5) * 0.045);
    this.setNaturalIdleParameter(layer, 'ParamBodyAngleZ', body * 0.035);
    this.setNaturalIdleParameter(layer, 'ParamShoulder', (breath - 0.5) * 0.04);
    this.setNaturalIdleParameter(layer, 'ParamHairFront', hair * 0.02);
    this.setNaturalIdleParameter(layer, 'ParamHairSideR', -hair * 0.015);

    while (elapsed - this.naturalBlinkStart > L2D_NATURAL_IDLE.blinkIntervalSeconds) {
      this.naturalBlinkStart += L2D_NATURAL_IDLE.blinkIntervalSeconds;
    }
    const blinkElapsed = elapsed - this.naturalBlinkStart;
    let eyeOpen = this.motionMap.size ? null : L2D_NATURAL_IDLE.fallbackEyeOpen;
    if (blinkElapsed >= 0 && blinkElapsed <= L2D_NATURAL_IDLE.blinkDurationSeconds) {
      const half = L2D_NATURAL_IDLE.blinkDurationSeconds * 0.5;
      const close = blinkElapsed <= half
        ? smoothStep(clamp(blinkElapsed / half, 0, 1))
        : 1 - smoothStep(clamp((blinkElapsed - half) / half, 0, 1));
      eyeOpen = (eyeOpen ?? 1) * (1 - close);
    }
    if (eyeOpen != null) {
      this.setNaturalIdleParameter(layer, 'ParamEyeLOpen', eyeOpen);
      this.setNaturalIdleParameter(layer, 'ParamEyeROpen', eyeOpen);
    }
  }

  setNaturalIdleParameter(layer, id, value) {
    const core = this.model?.internalModel?.coreModel;
    if (!core || !id || !Number.isFinite(value)) return;
    let index = -1;
    try { index = core.getParameterIndex?.(id); } catch (_) {}
    if (!Number.isInteger(index) || index < 0) return;
    let min = -Infinity;
    let max = Infinity;
    try { min = Number(core.getParameterMinimumValue?.(index)); } catch (_) {}
    try { max = Number(core.getParameterMaximumValue?.(index)); } catch (_) {}
    const next = Number.isFinite(min) && Number.isFinite(max) ? clamp(value, min, max) : value;
    layer.set(id, next);
  }

  cacheMosaicDrawables() {
    const internal = this.model?.internalModel;
    const ids = internal?.getDrawableIDs?.()
      || internal?.coreModel?.getDrawableIds?.()
      || internal?.coreModel?._model?.drawables?.ids
      || [];
    this.mosaicDrawables = Array.from(ids)
      .map((id, index) => ({ id: String(id), index }))
      .map((item) => ({ ...item, material: mosaicDrawableMaterial(item.id) }))
      .filter((item) => item.material)
      .map((item) => ({
        ...item,
      }));
    const mosaicCount = this.mosaicDrawables.filter((item) => item.material === 'mosaic').length;
    const invertedCount = this.mosaicDrawables.filter((item) => item.material === 'inverted').length;
    this.mosaicStatus = this.mosaicDrawables.length
      ? `${mosaicCount} mosaic / ${invertedCount} inverted masks`
      : 'no mosaic drawables';
  }

  installMosaicDrawableSuppression() {
    const internal = this.model?.internalModel;
    if (!internal || this.mosaicDrawPatchInstalled || typeof internal.draw !== 'function') return;
    const originalDraw = internal.draw.bind(internal);
    internal.draw = (gl) => {
      this.suppressMosaicDrawables();
      return originalDraw(gl);
    };
    this.mosaicDrawPatchInstalled = true;
  }

  suppressMosaicDrawables() {
    const opacities = this.model?.internalModel?.coreModel?._model?.drawables?.opacities;
    if (!opacities || !this.mosaicDrawables.length) return;
    for (const drawable of this.mosaicDrawables) {
      if (drawable.index >= 0 && drawable.index < opacities.length) opacities[drawable.index] = 0;
    }
  }

  refreshMosaicSourceCanvas() {
    if (!this.app?.renderer || !this.app?.stage || !this.model) return;
    this.suppressMosaicDrawables();
    try {
      this.app.renderer.render(this.app.stage);
    } catch (_) {}
    this.suppressMosaicDrawables();
  }

  renderMosaicOverlay() {
    const canvas = el.mosaicLayer;
    if (!canvas) return;
    const drawables = this.activeMosaicDrawables();
    if (this.mosaicMode === 'off' || !this.visible || !this.model || !drawables.length) {
      this.clearMosaicOverlay();
      return;
    }

    const dpr = resizeOverlayCanvas(canvas);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const source = el.live2dCanvas;
    if (!source?.width || !source?.height) return;
    this.refreshMosaicSourceCanvas();
    const block = Math.max(2, Math.floor(Math.min(canvas.width / MOSAIC_PIXEL_DIV_X, canvas.height / MOSAIC_PIXEL_DIV_Y)));
    let drew = false;
    for (const drawable of drawables) {
      const mesh = this.drawableStageMesh(drawable.index, dpr);
      if (!mesh || mesh.rect.width <= 1 || mesh.rect.height <= 1) continue;
      pixelateCanvasMesh(source, canvas, this.mosaicScratch, mesh, block);
      drew = true;
    }
    this.mosaicStatus = drew
      ? `${drawables.length} ${mosaicModeLabel(this.mosaicMode)} masks`
      : 'drawable bounds unavailable';
  }

  activeMosaicDrawables() {
    if (this.mosaicMode === 'off') return [];
    if (this.mosaicMode === 'mosaic') return this.mosaicDrawables.filter((item) => item.material === 'mosaic');
    if (this.mosaicMode === 'inverted') return this.mosaicDrawables.filter((item) => item.material === 'inverted');
    return this.mosaicDrawables;
  }

  drawableStageMesh(index, dpr) {
    if (!window.PIXI?.Point || !this.model?.toGlobal) return null;
    const vertices = this.drawableVertices(index);
    const indices = this.drawableVertexIndices(index);
    if (!vertices?.length || !indices?.length) return null;

    const points = [];
    const canvas = el.mosaicLayer;
    const maxWidth = canvas?.width || 1;
    const maxHeight = canvas?.height || 1;
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    for (let i = 0; i + 1 < vertices.length; i += 2) {
      const point = this.model.toGlobal(new PIXI.Point(Number(vertices[i]) || 0, Number(vertices[i + 1]) || 0));
      const x = point.x * dpr;
      const y = point.y * dpr;
      points.push({ x, y });
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null;

    left = clamp(Math.floor(left) - MOSAIC_PADDING_PX * dpr, 0, maxWidth);
    top = clamp(Math.floor(top) - MOSAIC_PADDING_PX * dpr, 0, maxHeight);
    right = clamp(Math.ceil(right) + MOSAIC_PADDING_PX * dpr, 0, maxWidth);
    bottom = clamp(Math.ceil(bottom) + MOSAIC_PADDING_PX * dpr, 0, maxHeight);
    return {
      points,
      indices: Array.from(indices),
      rect: {
        x: left,
        y: top,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top),
      },
    };
  }

  drawableVertices(index) {
    const internal = this.model?.internalModel;
    try {
      const vertices = internal?.getDrawableVertices?.(index);
      if (vertices?.length) return Array.from(vertices);
    } catch (_) {}
    try {
      const vertices = internal?.coreModel?.getDrawableVertices?.(index);
      if (vertices?.length) return Array.from(vertices);
    } catch (_) {}
    return null;
  }

  drawableVertexIndices(index) {
    const core = this.model?.internalModel?.coreModel;
    try {
      const indices = core?.getDrawableVertexIndices?.(index);
      if (indices?.length) return Array.from(indices);
    } catch (_) {}
    try {
      const indices = core?._model?.drawables?.indices?.[index];
      if (indices?.length) return Array.from(indices);
    } catch (_) {}
    return null;
  }

  drawableBounds(index) {
    const internal = this.model?.internalModel;
    if (!internal) return null;
    try {
      if (typeof internal.getDrawableBounds === 'function') {
        const bounds = internal.getDrawableBounds(index, {});
        if (bounds && Number.isFinite(bounds.width) && Number.isFinite(bounds.height)) return bounds;
      }
    } catch (_) {}
    try {
      const vertices = internal.getDrawableVertices?.(index);
      if (!vertices?.length) return null;
      let left = Infinity;
      let right = -Infinity;
      let top = Infinity;
      let bottom = -Infinity;
      for (let i = 0; i + 1 < vertices.length; i += 2) {
        const x = Number(vertices[i]);
        const y = Number(vertices[i + 1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
      if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
      return { x: left, y: top, width: right - left, height: bottom - top };
    } catch (_) {
      return null;
    }
  }

  drawableStageRect(bounds, dpr) {
    if (!window.PIXI?.Point || !this.model?.toGlobal) return null;
    const p1 = this.model.toGlobal(new PIXI.Point(bounds.x, bounds.y));
    const p2 = this.model.toGlobal(new PIXI.Point(bounds.x + bounds.width, bounds.y + bounds.height));
    const left = Math.min(p1.x, p2.x) - MOSAIC_PADDING_PX;
    const top = Math.min(p1.y, p2.y) - MOSAIC_PADDING_PX;
    const right = Math.max(p1.x, p2.x) + MOSAIC_PADDING_PX;
    const bottom = Math.max(p1.y, p2.y) + MOSAIC_PADDING_PX;
    const maxWidth = el.stage.clientWidth || 1;
    const maxHeight = el.stage.clientHeight || 1;
    const clippedLeft = clamp(left, 0, maxWidth);
    const clippedTop = clamp(top, 0, maxHeight);
    const clippedRight = clamp(right, 0, maxWidth);
    const clippedBottom = clamp(bottom, 0, maxHeight);
    return {
      x: Math.round(clippedLeft * dpr),
      y: Math.round(clippedTop * dpr),
      width: Math.round((clippedRight - clippedLeft) * dpr),
      height: Math.round((clippedBottom - clippedTop) * dpr),
    };
  }

  clearMosaicOverlay() {
    const canvas = el.mosaicLayer;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width || 1, canvas.height || 1);
  }

  applyHeldParameters() {
    this.heldParameters.clear();
    const groups = Array.from(this.parameterLayers.keys()).sort((left, right) => {
      const diff = live2dGroupPriority(left) - live2dGroupPriority(right);
      return diff || String(left).localeCompare(String(right));
    });
    for (const group of groups) {
      const layer = this.parameterLayers.get(group);
      if (!layer) continue;
      for (const [id, value] of layer.entries()) this.heldParameters.set(id, value);
    }
    for (const [id, value] of this.heldParameters.entries()) this.setParameter(id, value);
  }

  setParameter(id, value) {
    try {
      this.model?.internalModel?.coreModel?.setParameterValueById?.(id, value);
    } catch (_) {}
  }

  hasParameter(id) {
    return this.actualParameterExists(id);
  }

  actualParameterIds() {
    const core = this.model?.internalModel?.coreModel;
    if (!core) return [];
    const candidates = [
      core._parameterIds,
      core.parameterIds,
      core.parameters?.ids,
      core._parameterIds?.values,
    ];
    for (const source of candidates) {
      if (!source) continue;
      if (Array.isArray(source)) return source.map(String);
      if (source instanceof Set) return Array.from(source, String);
      if (typeof source.length === 'number') {
        try { return Array.from(source, String); } catch (_) {}
      }
    }
    return [];
  }

  actualParameterExists(id) {
    const core = this.model?.internalModel?.coreModel;
    if (!core || !id) return false;
    const ids = this.actualParameterIds();
    if (ids.length) return ids.includes(id);
    try {
      const index = core.getParameterIndex?.(id);
      return Number.isInteger(index) && index >= 0;
    } catch (_) {
      return false;
    }
  }

  resolveLipSyncParameterId(suffix) {
    const clean = String(suffix || '').trim();
    if (!clean) return '';
    const parameterId = `${L2D_LIP_SYNC.mouthParameterPrefix}${clean}`;
    if (this.actualParameterExists(parameterId)) return parameterId;
    return this.resolveExportedLipSyncParameterId(clean);
  }

  resolveExportedLipSyncParameterId(suffix) {
    const numeric = Number.parseInt(suffix, 10);
    if (!Number.isFinite(numeric) || numeric <= 0) return '';
    const compactId = `${L2D_LIP_SYNC.mouthParameterPrefix}${numeric}`;
    if (this.actualParameterExists(compactId)) return compactId;
    if (numeric === 1 && this.actualParameterExists(L2D_LIP_SYNC.mouthParameterPrefix)) {
      return L2D_LIP_SYNC.mouthParameterPrefix;
    }
    return '';
  }

  composedParameterValue(id) {
    const groups = Array.from(this.parameterLayers.keys()).sort((left, right) => {
      const diff = live2dGroupPriority(left) - live2dGroupPriority(right);
      return diff || String(left).localeCompare(String(right));
    });
    let value = this.defaultParameterValue(id);
    for (const group of groups) {
      const layer = this.parameterLayers.get(group);
      if (layer?.has(id)) value = layer.get(id);
    }
    return value;
  }

  disableSdkIdleMotion() {
    const motionManager = this.model?.internalModel?.motionManager;
    if (!motionManager) return;
    try { motionManager.stopAllMotions?.(); } catch (_) {}
    try { motionManager._stopAllMotions?.(); } catch (_) {}
    if (motionManager.groups) {
      delete motionManager.groups.idle;
      delete motionManager.groups.Idle;
    }
    if (motionManager.definitions) {
      motionManager.definitions.Idle = [];
      motionManager.definitions.idle = [];
    }
    if (motionManager.motionGroups) {
      motionManager.motionGroups.Idle = [];
      motionManager.motionGroups.idle = [];
    }
    if (motionManager.state) {
      motionManager.state.currentGroup = '';
      motionManager.state.currentIndex = -1;
      motionManager.state.currentPriority = 0;
      motionManager.state.reservePriority = 0;
    }
    motionManager.playing = false;
  }

  disableSdkNaturalMotion() {
    const internalModel = this.model?.internalModel;
    if (!internalModel) return;
    try { internalModel.updateNaturalMovements = () => {}; } catch (_) {}
    try { internalModel.updateFocus = () => {}; } catch (_) {}
    try { internalModel.breath = null; } catch (_) {}
    try {
      if (internalModel.focusController) {
        internalModel.focusController.update = () => {};
        internalModel.focusController.x = 0;
        internalModel.focusController.y = 0;
      }
    } catch (_) {}
  }

  defaultParameterValue(id) {
    const core = this.model?.internalModel?.coreModel;
    if (!core) return null;
    try {
      const index = core.getParameterIndex?.(id);
      if (Number.isInteger(index) && index >= 0) return core.getParameterDefaultValue(index);
    } catch (_) {}
    try {
      return core.getParameterValueById?.(id);
    } catch (_) {
      return null;
    }
  }

  resetMotionGroup(name) {
    const text = String(name || '');
    if (!/Reset$/i.test(text)) return false;
    const group = text.replace(/Reset$/i, '');
    const ids = this.groupParameterIds.get(group);
    if (!ids?.size) return false;
    this.motionGeneration.set(group, (this.motionGeneration.get(group) || 0) + 1);
    const lastMotion = this.lastMotionByGroup.get(group);
    const fadeOut = Math.max(0, Number(lastMotion?.fadeOutTime ?? 0.2));
    this.fadeLayerToDefaults(group, ids, fadeOut);
    return true;
  }

  fadeLayerToDefaults(group, ids, seconds) {
    const generation = this.motionGeneration.get(group) || 0;
    const layer = this.ensureParameterLayer(group);
    const started = performance.now();
    const startValues = new Map();
    const targetValues = new Map();
    for (const id of ids) {
      startValues.set(id, layer.has(id) ? layer.get(id) : this.composedParameterValue(id));
      targetValues.set(id, this.defaultParameterValue(id));
    }
    const tick = () => {
      if (!this.model || this.motionGeneration.get(group) !== generation) return;
      const elapsed = (performance.now() - started) / 1000;
      const weight = seconds > 0 ? smoothStep(clamp(elapsed / seconds, 0, 1)) : 1;
      for (const id of ids) {
        const target = targetValues.get(id);
        if (target == null) layer.delete(id);
        else layer.set(id, lerp(startValues.get(id) ?? target, target, weight));
      }
      this.applyHeldParameters();
      if (weight < 1) requestAnimationFrame(tick);
    };
    tick();
  }

  stopMotionGroupForName(name) {
    const motion = this.motionMap.get(normalizeKey(name));
    const group = motion?.group || String(name || '').replace(/Reset$/i, '');
    if (!group) return false;
    this.motionGeneration.set(group, (this.motionGeneration.get(group) || 0) + 1);
    this.parameterLayers.delete(group);
    this.applyHeldParameters();
    return true;
  }

  setLipSyncMode(mode) {
    const key = normalizeKey(mode || 'multi');
    this.lipSyncModeMulti = key === 'multi' || key === 'on' || key === 'true' || key === '1';
  }

  playLipSync(voiceId, useMultiCharacterLipSync = true) {
    const suffix = extractLive2DVoiceSuffix(voiceId);
    if (!suffix) {
      this.stopLipSync();
      return;
    }
    const parameterId = this.resolveLipSyncParameterId(suffix);
    if (!parameterId) {
      this.stopLipSync();
      return;
    }
    const previous = this.lipSync?.parameterId;
    if (previous) this.clearLipSyncParameter(previous);
    this.lipSync = {
      voiceId,
      suffix,
      parameterId,
      useMultiCharacterLipSync,
      mouseY: 0,
      mouseTargetY: 0,
      waitingSec: 0,
      audioPlayTime: 0,
      lastNow: performance.now(),
    };
    this.ensureParameterLayer(L2D_LIP_SYNC.layer);
  }

  stopLipSync() {
    if (this.lipSync?.parameterId) this.clearLipSyncParameter(this.lipSync.parameterId);
    this.lipSync = null;
    this.parameterLayers.delete(L2D_LIP_SYNC.layer);
    this.applyHeldParameters();
  }

  clearLipSyncParameter(parameterId) {
    const layer = this.parameterLayers.get(L2D_LIP_SYNC.layer);
    if (!layer) return;
    layer.delete(parameterId);
  }

  updateLipSync() {
    const state = this.lipSync;
    if (!state?.useMultiCharacterLipSync || !state.suffix) return;
    const now = performance.now();
    const dt = Math.max(0, (now - state.lastNow) / 1000);
    state.lastNow = now;
    state.audioPlayTime += dt;

    const voiceLength = app.controller?.sound?.currentVoiceLengthSeconds?.() || 0;
    const voiceTime = app.controller?.sound?.currentVoiceTimeSeconds?.() || state.audioPlayTime;
    const nearEnd = voiceLength > 0 && voiceTime > voiceLength - L2D_LIP_SYNC.blendModeSwitchTimeBeforeEnd;
    const layer = this.ensureParameterLayer(L2D_LIP_SYNC.layer);
    if (nearEnd) {
      layer.delete(state.parameterId);
      return;
    }

    if (state.waitingSec >= L2D_LIP_SYNC.targetWaitSec) {
      state.waitingSec = 0;
      state.mouseTargetY = app.controller?.sound?.currentVoiceMouthOpening?.() || 0;
    } else {
      const t = L2D_LIP_SYNC.targetWaitSec > 0 ? clamp(state.waitingSec / L2D_LIP_SYNC.targetWaitSec, 0, 1) : 1;
      state.mouseY = lerp(state.mouseY, state.mouseTargetY, t);
    }
    state.waitingSec += dt;
    state.mouseY = Math.max(0, state.mouseY);
    if (this.actualParameterExists(state.parameterId)) layer.set(state.parameterId, state.mouseY);
    else layer.delete(state.parameterId);
  }

  fit() {
    if (!this.model) return;
    const w = el.stage.clientWidth || 1;
    const h = el.stage.clientHeight || 1;
    this.app?.renderer?.resize?.(w, h);
    const previousScaleX = this.model.scale?.x || 1;
    const previousScaleY = this.model.scale?.y || previousScaleX;
    this.model.scale?.set?.(1);
    let bounds = null;
    try {
      bounds = this.model.getLocalBounds?.();
    } catch (_) {
      bounds = null;
    }
    if (!bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) || bounds.width <= 0 || bounds.height <= 0) {
      bounds = {
        x: 0,
        y: 0,
        width: Math.max(1, this.model.width / previousScaleX),
        height: Math.max(1, this.model.height / previousScaleY),
      };
    }
    const scale = Math.min(w / Math.max(1, bounds.width), h / Math.max(1, bounds.height)) * 0.98;
    this.model.scale.set(scale);
    this.model.x = w * 0.5 - (bounds.x + bounds.width * 0.5) * scale;
    this.model.y = h * 0.98 - (bounds.y + bounds.height) * scale;
    this.renderMosaicOverlay();
  }
}

class NovelModelAsync {
  constructor() {
    this.reset();
  }

  reset() {
    this.pending = [];
    this.nextId = 1;
  }

  begin(tag, mode, commandName) {
    const item = {
      id: this.nextId,
      tag: tag || '',
      mode: mode || 'CONT',
      commandName: commandName || '',
      canceled: false,
      promise: null,
    };
    this.nextId += 1;
    this.pending.push(item);
    return item;
  }

  track(item, promise) {
    item.promise = Promise.resolve(promise)
      .catch((error) => {
        setStatus(`async command failed: ${error?.message || error}`, true);
      })
      .finally(() => {
        this.pending = this.pending.filter((entry) => entry !== item);
      });
    return item.promise;
  }

  isActive(item) {
    return !!item && !item.canceled && this.pending.includes(item);
  }

  wait(tag = '') {
    const key = String(tag || '').toLowerCase();
    const promises = this.pending
      .filter((entry) => !key || String(entry.tag).toLowerCase() === key)
      .map((entry) => entry.promise);
    return promises.length ? Promise.allSettled(promises) : Promise.resolve();
  }

  removeEndCommand() {
    this.pending = this.pending.filter((entry) => !entry.ended);
  }

  cancel(tag = '') {
    const key = String(tag || '').toLowerCase();
    for (const entry of this.pending) {
      if (!key || String(entry.tag).toLowerCase() === key) entry.canceled = true;
    }
    if (!key) this.pending = [];
    else this.pending = this.pending.filter((entry) => String(entry.tag).toLowerCase() !== key);
  }

  skip(tag = '') {
    this.removeEndCommand();
    this.cancel(tag);
  }

  stop(tag = '') {
    this.removeEndCommand();
    this.cancel(tag);
  }

  pendingLabels() {
    return this.pending.map((entry) => `${entry.mode}:${entry.tag || '(untagged)'}#${entry.id}`);
  }
}

class NovelCommandRegistry {
  constructor() {
    this.commands = new Map();
  }

  register(name, command) {
    this.commands.set(name.toLowerCase(), command);
    return this;
  }

  async execute(context, rawCommand) {
    const name = String(rawCommand.command || '').toLowerCase();
    const command = this.commands.get(name) || this.commands.get(baseCommandName(name)) || new NoopCommand();
    return command.execute(context, rawCommand, new NovelArguments(rawCommand));
  }
}

class NovelCommandBase {
  async execute(context, command, args) {
    return this.onExecute(context, command, args);
  }

  async onExecute() {
    return undefined;
  }
}

class NovelCommandAsyncBase extends NovelCommandBase {
  async runAsync(context, command, options, action) {
    if (context.replaying) {
      await action();
      return undefined;
    }

    const item = context.models.async.begin(options.tag, options.mode, command.command);
    const task = (async () => {
      if (!isImmediateDelay(options.delay)) await waitAsyncSeconds(options.delay, context.asyncToken);
      await this.runAsyncAction(context, options, action, item);
    })();
    context.models.async.track(item, task);
    return undefined;
  }

  async runAsyncAction(context, options, action, asyncItem) {
    if (!context.models.async.isActive(asyncItem)) return;
    if (context.asyncToken !== app.asyncToken) return;
    await action();
    if (!context.models.async.isActive(asyncItem)) return;
    context.models.scene.render();
    updateInspectors();
    if (options.duration > 0) await waitAsyncSeconds(options.duration, context.asyncToken);
    if (context.models.async.isActive(asyncItem)) asyncItem.ended = true;
  }

  asyncOptions(args, asyncCodeIndex, delayIndex, tagIndex = -1, duration = 0) {
    return {
      mode: parseAsyncMode(args.string(asyncCodeIndex, 'CONT')),
      delay: args.float(delayIndex, 0),
      tag: tagIndex > 0 ? args.string(tagIndex, '') : '',
      duration,
    };
  }
}

class NoopCommand extends NovelCommandBase {}

class LabelCommand extends NovelCommandBase {
  async onExecute(context, command) {
    context.models.scene.state.currentLabel = command.label || command.rawCommand?.replace(/^:/, '');
  }
}

class LabelJumpCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const label = args.string(1);
    const jumpIndex = context.player.labels.get(label.toLowerCase());
    return jumpIndex == null || context.replaying ? undefined : { jumpIndex };
  }
}

class PlotCommand extends NovelCommandBase {}

class EndOfCommand extends NovelCommandBase {}

class WaitCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    if (!context.replaying) await waitSeconds(args.float(1, 0), context.token);
  }
}

class WaitOrClickCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const seconds = args.float(1, 0);
    if (!context.replaying && seconds > 0) await waitSeconds(seconds, context.token);
  }
}

class AsyncWaitCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    if (context.replaying) return;
    const value = args.string(1);
    await context.models.async.wait(value);
  }
}

class AsyncSkipWaitCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    context.models.async.skip(args.string(1, ''));
  }
}

class AsyncStopWaitCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    context.models.async.stop(args.string(1, ''));
  }
}

class CleanAllCommand extends NovelCommandBase {
  async onExecute(context) {
    context.models.message.reset();
    context.models.screen.reset();
    context.models.scene.reset();
    context.models.async.reset();
  }
}

class CleanSkipCommand extends NovelCommandBase {
  async onExecute(context) {
    context.models.message.reset();
    context.models.screen.clearSkipArtifacts();
  }
}

class MessageCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const speaker = command.speaker || args.string(1);
    const text = command.message || args.string(2);
    const voiceCue = context.models.sound.consumeMessageVoice(command.voice || args.string(4));
    context.models.live2d.stopLipSync();
    context.models.message.show(speaker, text, voiceCue);
    if (!context.replaying && voiceCue) context.models.sound.play(voiceCue, 'voice', 'voice', { volume: 1 });
    return { pauseOnText: true };
  }
}

class L2DMessageCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const speaker = command.speaker || args.string(1);
    const text = command.message || args.string(2);
    const voiceCue = context.models.sound.consumeMessageVoice(command.voice || args.string(4));
    context.models.message.show(speaker, text, voiceCue);
    if (voiceCue) {
      if (!context.replaying) context.models.sound.play(voiceCue, 'voice', 'voice', { volume: 1 });
      context.models.live2d.playLipSync(voiceCue, context.models.live2d.lipSyncModeMulti);
    } else {
      context.models.live2d.stopLipSync();
    }
    return { pauseOnText: true };
  }
}

class L2DLipSyncModeCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    context.models.live2d.setLipSyncMode(args.string(1, 'multi'));
  }
}

class VoiceCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    context.models.sound.queueVoice(args.string(1), args.on(2, true));
  }
}

class VoiceStopCommand extends NovelCommandBase {
  async onExecute(context) {
    context.models.sound.stopVoiceAll();
    context.models.live2d.stopLipSync();
  }
}

class LoadVoiceCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const scriptId = args.string(1);
    if (!scriptId) return;
    context.models.sound.preloadCue(scriptId);
  }
}

class DotMessageCommand extends MessageCommand {}
class MessageTextCenterCommand extends MessageCommand {}

class MessageTextUnderCommand extends MessageTextCenterCommand {}

class TitleCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    context.models.message.show('', command.message || args.string(1));
    return { pauseOnText: true };
  }
}

class WindowCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const visible = args.on(1, false);
    const seconds = args.float(2, .5);
    context.models.message.setWindow(visible, seconds);
    if (!context.replaying) await waitSeconds(seconds, context.token);
  }
}

class UiVisibleCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    document.body.dataset.uiVisible = String(args.on(1, true));
  }
}

class AdultUiCommand extends UiVisibleCommand {}
class MessageTextWindowCommand extends WindowCommand {}
class LineworkCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    context.models.screen.state.linework = { on: args.on(1, true), color: args.string(2), style: args.string(3), seconds: args.float(4, 0) };
  }
}

class FadeCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const seconds = args.float(3, 1);
    context.models.screen.fade(args.string(1, 'In'), args.string(2, 'Black'), seconds);
    if (!context.replaying) await waitSeconds(seconds, context.token);
  }
}

class AsyncFadeCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const seconds = args.float(3, 1);
    const options = this.asyncOptions(args, 4, 5, -1, seconds);
    return this.runAsync(context, command, options, async () => {
      context.models.screen.fade(args.string(1, 'In'), args.string(2, 'Black'), seconds);
    });
  }
}

class CrossFadeReadyCommand extends NovelCommandBase {
  async onExecute(context) {
    context.models.screen.captureCrossFade();
  }
}

class AsyncCrossFadeReadyCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const options = this.asyncOptions(args, 1, 2, -1, 0);
    return this.runAsync(context, command, options, async () => {
      context.models.screen.captureCrossFade();
    });
  }
}

class CrossFadeCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const seconds = args.float(1, .5);
    context.models.screen.crossFade(context.replaying ? 0 : seconds, args.float(2, 0), args.float(3, 0), args.float(4, 1), args.float(5, 1));
    if (!context.replaying) await waitSeconds(seconds, context.token);
    context.models.screen.clearCrossFade();
  }
}

class AsyncCrossFadeCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const seconds = args.float(1, .5);
    const options = this.asyncOptions(args, 6, 7, -1, 0);
    return this.runAsync(context, command, options, async () => {
      context.models.screen.crossFade(context.replaying ? 0 : seconds, args.float(2, 0), args.float(3, 0), args.float(4, 1), args.float(5, 1));
      if (!context.replaying) await waitAsyncSeconds(seconds, context.asyncToken);
      context.models.screen.clearCrossFade();
    });
  }
}

class ColorFadeCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const seconds = args.float(1, 1);
    context.models.screen.colorFade(seconds, args.float(2, 0), args.float(3, 0), args.float(4, 0), args.float(5, 0), args.float(6, 0));
    if (!context.replaying) await waitSeconds(seconds, context.token);
  }
}

class AsyncColorFadeCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const seconds = args.float(1, 1);
    const options = this.asyncOptions(args, 7, 8, -1, seconds);
    return this.runAsync(context, command, options, async () => {
      context.models.screen.colorFade(seconds, args.float(2, 0), args.float(3, 0), args.float(4, 0), args.float(5, 0), args.float(6, 0));
    });
  }
}

class TransitionFadeCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const seconds = args.float(4, .5);
    context.models.screen.transitionFade(args.string(1, ''), args.string(2, 'Out'), args.string(3, 'Black'), context.replaying ? 0 : seconds);
    if (!context.replaying) await waitSeconds(seconds, context.token);
  }
}

class AsyncTransitionFadeCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const seconds = args.float(4, .5);
    const options = this.asyncOptions(args, 5, 6, -1, seconds);
    return this.runAsync(context, command, options, async () => {
      context.models.screen.transitionFade(args.string(1, ''), args.string(2, 'Out'), args.string(3, 'Black'), context.replaying ? 0 : seconds);
    });
  }
}

class TransitionCrossFadeReadyCommand extends NovelCommandBase {
  async onExecute(context) {
    context.models.screen.captureTransitionCrossFade();
  }
}

class AsyncTransitionCrossFadeReadyCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const options = this.asyncOptions(args, 1, 2, -1, 0);
    return this.runAsync(context, command, options, async () => {
      context.models.screen.captureTransitionCrossFade();
    });
  }
}

class TransitionCrossFadeCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const seconds = args.float(2, .5);
    context.models.screen.transitionCrossFade(args.string(1, ''), context.replaying ? 0 : seconds);
    if (!context.replaying) {
      await waitSeconds(seconds, context.token);
      context.models.screen.clearTransitionCrossFade();
    }
  }
}

class AsyncTransitionCrossFadeCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const seconds = args.float(2, .5);
    const options = this.asyncOptions(args, 3, 4, -1, 0);
    return this.runAsync(context, command, options, async () => {
      context.models.screen.transitionCrossFade(args.string(1, ''), context.replaying ? 0 : seconds);
      if (!context.replaying) await waitAsyncSeconds(seconds, context.asyncToken);
      context.models.screen.clearTransitionCrossFade();
    });
  }
}

class BlurCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const seconds = args.float(3, 1);
    context.models.screen.blur(args.on(1, false), args.string(2, ''), seconds);
    if (!context.replaying) await waitSeconds(seconds, context.token);
  }
}

class AsyncBlurCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const seconds = args.float(3, 1);
    const options = this.asyncOptions(args, 4, 5, -1, seconds);
    return this.runAsync(context, command, options, async () => {
      context.models.screen.blur(args.on(1, false), args.string(2, ''), seconds);
    });
  }
}

class ScreenEffectCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const seconds = args.float(3, 1);
    context.models.screen.screenEffect(args.string(1), args.on(2, false), seconds, args.float(4, 1));
    if (!context.replaying) await waitSeconds(seconds, context.token);
  }
}

class AsyncScreenEffectCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const seconds = args.float(3, 1);
    const options = this.asyncOptions(args, 5, 6, 1, seconds);
    return this.runAsync(context, command, options, async () => {
      context.models.screen.screenEffect(args.string(1), args.on(2, false), seconds, args.float(4, 1));
    });
  }
}

class Live2DInitCommand extends NovelCommandBase {
  async onExecute() {
    // Original command loads the R18 Live2D voice cue sheet and does not show the model.
  }
}

class L2DShowCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    context.models.live2d.show(args.string(1, command.model || LIVE2D_TAG));
    if (!context.replaying) await context.models.live2d.waitLoadComplete(context.token);
  }
}

class L2DHideCommand extends NovelCommandBase {
  async onExecute(context) {
    context.models.live2d.hide();
  }
}

class L2DMotionCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const motion = args.string(1, command.motion || '');
    const enabled = args.on(2, true);
    context.models.live2d.playMotion(motion, enabled);
  }
}

class AsyncL2DMotionCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const motion = args.string(1);
    const enabled = args.on(2, true);
    const options = this.asyncOptions(args, 3, 4);
    return this.runAsync(context, command, options, async () => {
      context.models.live2d.playMotion(motion, enabled);
    });
  }
}

class AsyncL2DHideCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const options = this.asyncOptions(args, 1, 2);
    return this.runAsync(context, command, options, async () => context.models.live2d.hide());
  }
}

class BgmPlayCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const tag = args.string(1, 'bgm');
    const cue = args.string(2, command.cue || '');
    const fadeInSeconds = args.float(3, .75);
    const volume = args.float(4, 1);
    const endActionOn = args.on(5, true);
    if (context.replaying && !endActionOn) return;
    if (!cue) {
      context.models.sound.fadeChannel('bgm', tag, 0, 0);
      return;
    }
    context.models.sound.play(cue, 'bgm', tag, {
      volume,
      fadeInSeconds,
      loop: true,
    });
  }
}

class AsyncBgmPlayCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const tag = args.string(1, 'bgm');
    const cue = args.string(2, command.cue || '');
    const fadeInSeconds = args.float(3, .75);
    const volume = args.float(4, 1);
    const endActionOn = args.on(5, true);
    const options = this.asyncOptions(args, 6, 7);
    return this.runAsync(context, command, options, async () => {
      if (context.replaying && !endActionOn) return;
      if (!cue) {
        context.models.sound.fadeChannel('bgm', tag, 0, 0);
        return;
      }
      context.models.sound.play(cue, 'bgm', tag, { volume, fadeInSeconds, loop: true });
    });
  }
}

class BgmPlayWorkunitCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const tag = args.string(1, 'bgm');
    const workunit = args.string(2, '');
    const acbFile = args.string(3, '');
    const cue = args.string(4, command.cue || '');
    const fadeInSeconds = args.float(5, .75);
    const volume = args.float(6, 1);
    const endActionOn = args.on(7, true);
    if (context.replaying && !endActionOn) return;
    if (!workunit || !acbFile || !cue) {
      context.models.sound.fadeChannel('bgm', tag, 0, 0);
      return;
    }
    context.models.sound.play(cue, 'bgm', tag, { volume, fadeInSeconds, loop: true });
  }
}

class AsyncBgmPlayWorkunitCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const tag = args.string(1, 'bgm');
    const workunit = args.string(2, '');
    const acbFile = args.string(3, '');
    const cue = args.string(4, command.cue || '');
    const fadeInSeconds = args.float(5, .75);
    const volume = args.float(6, 1);
    const endActionOn = args.on(7, true);
    const options = this.asyncOptions(args, 8, 9);
    return this.runAsync(context, command, options, async () => {
      if (context.replaying && !endActionOn) return;
      if (!workunit || !acbFile || !cue) {
        context.models.sound.fadeChannel('bgm', tag, 0, 0);
        return;
      }
      context.models.sound.play(cue, 'bgm', tag, { volume, fadeInSeconds, loop: true });
    });
  }
}

class BgmFadeCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    if (context.replaying && !args.on(4, true)) return;
    context.models.sound.fadeChannel('bgm', args.string(1, 'bgm'), args.float(3, 1), args.float(2, .75));
  }
}

class AsyncBgmFadeCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const tag = args.string(1, 'bgm');
    const seconds = args.float(2, .75);
    const volume = args.float(3, 1);
    const endActionOn = args.on(4, true);
    const options = this.asyncOptions(args, 5, 6);
    return this.runAsync(context, command, options, async () => {
      if (context.replaying && !endActionOn) return;
      context.models.sound.fadeChannel('bgm', tag, volume, seconds);
    });
  }
}

class BgmStopCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const tag = args.string(1, '');
    if (context.replaying && !args.on(3, true)) return;
    if (!tag) return;
    context.models.sound.fadeChannel('bgm', isAllTag(tag) ? '' : tag, 0, args.float(2, .75));
  }
}

class AsyncBgmStopCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const tag = args.string(1, '');
    const seconds = args.float(2, .75);
    const endActionOn = args.on(3, true);
    const options = this.asyncOptions(args, 4, 5);
    return this.runAsync(context, command, options, async () => {
      if (context.replaying && !endActionOn) return;
      if (tag) context.models.sound.fadeChannel('bgm', isAllTag(tag) ? '' : tag, 0, seconds);
    });
  }
}

class BgvPlayCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const tag = args.string(1, 'bgv');
    const cue = args.string(2, command.cue || '');
    const volume = args.float(3, 0);
    const highlight = args.on(4, false);
    context.models.sound.play(cue, 'bgv', tag, {
      volume: highlight ? 0 : volume,
      loop: false,
    });
    if (highlight) context.models.sound.fadeChannel('bgv', tag, volume, 0);
  }
}

class BgvFadeCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    context.models.sound.fadeChannel('bgv', args.string(1, 'bgv'), args.float(3, 1), args.float(2, .75));
  }
}

class BgvStopCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    context.models.sound.fadeStop('bgv', args.string(1, ''), args.float(2, .75));
  }
}

class SePlayCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const tag = args.string(1, 'se');
    const cue = args.string(2, command.cue || '');
    const fadeInSeconds = args.float(3, .75);
    const volume = args.float(4, 1);
    if (context.replaying) return;
    context.models.sound.play(cue, 'se', tag, { volume, fadeInSeconds });
  }
}

class AsyncSePlayCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const tag = args.string(1, 'se');
    const cue = args.string(2, command.cue || '');
    const fadeInSeconds = args.float(3, .75);
    const volume = args.float(4, 1);
    const options = this.asyncOptions(args, 5, 6);
    return this.runAsync(context, command, options, async () => {
      if (context.replaying) return;
      context.models.sound.play(cue, 'se', tag, { volume, fadeInSeconds });
    });
  }
}

class SeFadeCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    if (context.replaying && !args.on(4, true)) return;
    context.models.sound.fadeChannel('se', args.string(1, 'se'), args.float(3, 1), args.float(2, .75));
  }
}

class AsyncSeFadeCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const tag = args.string(1, 'se');
    const seconds = args.float(2, .75);
    const volume = args.float(3, 1);
    const endActionOn = args.on(4, true);
    const options = this.asyncOptions(args, 5, 6);
    return this.runAsync(context, command, options, async () => {
      if (context.replaying && !endActionOn) return;
      context.models.sound.fadeChannel('se', tag, volume, seconds);
    });
  }
}

class SeStopCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    if (context.replaying && !args.on(3, true)) return;
    context.models.sound.fadeStop('se', args.string(1, ''), args.float(2, .75));
  }
}

class AsyncSeStopCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const tag = args.string(1, '');
    const seconds = args.float(2, .75);
    const endActionOn = args.on(3, true);
    const options = this.asyncOptions(args, 4, 5);
    return this.runAsync(context, command, options, async () => {
      if (context.replaying && !endActionOn) return;
      context.models.sound.fadeStop('se', tag, seconds);
    });
  }
}

class CharaloadCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    await context.models.scene.loadCharacter(args.string(1, 'chara'), args.string(2), args.string(3));
  }
}

class CharaFaceCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    context.models.scene.faceCharacter(args.string(1), args.string(2));
  }
}

class CharaPoseCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    context.models.scene.poseCharacter(args.string(1), Number.parseInt(args.string(2, '0'), 10) || 0);
  }
}

class CharaMoveCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const moveType = args.string(2, 'Set');
    const seconds = normalizeCharaMoveType(moveType) === 'set' ? 0 : args.float(5, 1);
    context.models.scene.moveCharacter(args.string(1), moveType, args.string(3), args.float(4, 0), seconds);
    if (!context.replaying) await waitSeconds(seconds, context.token);
  }
}

class CharaScaleCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const seconds = args.float(3, 0);
    context.models.scene.scaleCharacter(args.string(1), args.float(2, 1), seconds);
    if (!context.replaying) await waitSeconds(seconds, context.token);
  }
}

class CharaShowCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const seconds = args.float(2, .25);
    context.models.scene.showCharacter(args.string(1), seconds, 1);
    if (!context.replaying) await waitSeconds(seconds, context.token);
  }
}

class CharaShowAlphaCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const seconds = args.float(3, .25);
    context.models.scene.showCharacter(args.string(1), seconds, args.float(2, 1));
    if (!context.replaying) await waitSeconds(seconds, context.token);
  }
}

class CharaHideCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const seconds = args.float(2, .25);
    context.models.scene.hideCharacter(args.string(1), seconds);
    if (!context.replaying) await waitSeconds(seconds, context.token);
  }
}

class CharaDeleteCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    context.models.scene.deleteCharacter(args.string(1));
  }
}

class CharaEmoCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const tag = args.string(1);
    const duration = context.models.scene.emotionCharacter(tag, args.string(2));
    context.models.scene.render();
    if (context.isReplayTarget(command)) return;
    if (!context.replaying) await waitSeconds(duration, context.token);
    context.models.scene.clearEmotion(tag);
  }
}

class EmoDeleteCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    context.models.scene.clearEmotion(args.string(1));
  }
}

class CharaFocusOnAllCommand extends NovelCommandBase {
  async onExecute(context) {
    context.models.scene.setAllCharacterFocus(true);
  }
}

class CharaFocusOnCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    context.models.scene.focusCharacter(args.string(1), true);
  }
}

class CharaFocusOutCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    context.models.scene.focusCharacter(args.string(1), false);
  }
}

class CharaFocusOutAllCommand extends NovelCommandBase {
  async onExecute(context) {
    context.models.scene.setAllCharacterFocus(false);
  }
}

class DefaultCharaColorCommand extends NovelCommandBase {
  async onExecute(context) {
    context.models.scene.setDefaultCharacterColor();
  }
}

class CharaMaskCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const seconds = args.float(4, 1);
    context.models.scene.maskCharacter(args.string(1), args.float(2, 0), args.float(3, 0), seconds);
    if (!context.replaying) await waitSeconds(seconds, context.token);
  }
}

class CharaItemCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const seconds = args.float(5, 0);
    context.models.scene.itemCharacter(args.string(1), Number(args.string(2, '0')), args.float(3, 0), args.float(4, 0), seconds);
    if (!context.replaying) await waitSeconds(seconds, context.token);
  }
}

class CharaReactionCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const seconds = args.float(3, 1);
    context.models.scene.reactCharacter(args.string(1), args.string(2), seconds);
    if (!context.replaying) await waitSeconds(seconds, context.token);
  }
}

class CharaColorCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const seconds = args.float(2, 0);
    context.models.scene.colorCharacter(args.string(1), seconds, args.string(3, '0'), args.string(4, '0'), args.string(5, '0'), args.string(6, '255'));
    if (!context.replaying) await waitSeconds(seconds, context.token);
  }
}

class AsyncCharaColorCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const seconds = args.float(2, 0);
    const options = this.asyncOptions(args, 7, 8, -1, seconds);
    return this.runAsync(context, command, options, async () => {
      context.models.scene.colorCharacter(args.string(1), seconds, args.string(3, '0'), args.string(4, '0'), args.string(5, '0'), args.string(6, '255'));
    });
  }
}

class AsyncCharaPoseCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const options = this.asyncOptions(args, 3, 4, -1, 0);
    return this.runAsync(context, command, options, async () => {
      context.models.scene.poseCharacter(args.string(1), Number.parseInt(args.string(2, '0'), 10) || 0);
    });
  }
}

class AsyncCharaDeleteCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    return this.runAsync(context, command, this.asyncOptions(args, 2, 3, 1, 0), async () => {
      context.models.scene.deleteCharacter(args.string(1));
    });
  }
}

class AsyncCharaFocusOnCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    return this.runAsync(context, command, this.asyncOptions(args, 2, 3, -1, 0), async () => {
      context.models.scene.focusCharacter(args.string(1), true);
    });
  }
}

class AsyncCharaFocusOnAllCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    return this.runAsync(context, command, this.asyncOptions(args, 2, 3, -1, 0), async () => {
      context.models.scene.setAllCharacterFocus(true);
    });
  }
}

class AsyncCharaFocusOutCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    return this.runAsync(context, command, this.asyncOptions(args, 3, 4, -1, 0), async () => {
      context.models.scene.focusCharacter(args.string(1), false);
    });
  }
}

class AsyncCharaFocusOutAllCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    return this.runAsync(context, command, this.asyncOptions(args, 2, 3, -1, 0), async () => {
      context.models.scene.setAllCharacterFocus(false);
    });
  }
}

class AsyncCharaMaskCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const seconds = args.float(4, 1);
    return this.runAsync(context, command, this.asyncOptions(args, 5, 6, 1, seconds), async () => {
      context.models.scene.maskCharacter(args.string(1), args.float(2, 0), args.float(3, 0), seconds);
    });
  }
}

class AsyncCharaItemCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const seconds = args.float(5, 0);
    return this.runAsync(context, command, this.asyncOptions(args, 6, 7, 1, seconds), async () => {
      context.models.scene.itemCharacter(args.string(1), Number(args.string(2, '0')), args.float(3, 0), args.float(4, 0), seconds);
    });
  }
}

class PriorityCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    context.models.scene.setPriority(args.string(1), args.string(2), args.string(3, '0'), args.string(4, ''), args.string(5, ''));
  }
}

class StillLoadCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    context.models.scene.loadStill(args.string(1), args.string(2));
  }
}

class StillChangeCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    context.models.scene.changeStill(args.string(1), args.int(2, 1));
  }
}

class AsyncStillChangeCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const options = this.asyncOptions(args, 3, 4, -1, 0);
    return this.runAsync(context, command, options, async () => {
      context.models.scene.changeStill(args.string(1), args.int(2, 1));
    });
  }
}

class StillShowCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const seconds = args.float(2, 0);
    context.models.scene.fadeStill(args.string(1), true, seconds);
    if (!context.replaying) await waitSeconds(seconds, context.token);
  }
}

class AsyncStillShowCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const seconds = args.float(2, 0);
    const options = this.asyncOptions(args, 3, 4, -1, seconds);
    return this.runAsync(context, command, options, async () => {
      context.models.scene.fadeStill(args.string(1), true, seconds);
    });
  }
}

class StillHideCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const seconds = args.float(2, 0);
    context.models.scene.fadeStill(args.string(1), false, seconds);
    if (!context.replaying) await waitSeconds(seconds, context.token);
  }
}

class AsyncStillHideCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const seconds = args.float(2, 0);
    const options = this.asyncOptions(args, 3, 4, -1, seconds);
    return this.runAsync(context, command, options, async () => {
      context.models.scene.fadeStill(args.string(1), false, seconds);
    });
  }
}

class StillDeleteCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    context.models.scene.deleteStill(args.string(1));
  }
}

class AsyncStillDeleteCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const options = this.asyncOptions(args, 2, 3, -1, 0);
    return this.runAsync(context, command, options, async () => {
      context.models.scene.deleteStill(args.string(1));
    });
  }
}

class SubimageCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    context.models.scene.createSubImage(args.string(1), args.string(2), args.float(3, 0), args.string(4, ''), args.int(5, 0), args.string(6, ''), args.string(7, ''));
  }
}

class SubimageFadeCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const seconds = args.float(4, 0);
    context.models.scene.fadeSubImage(args.string(1), args.string(2, '255'), args.string(3, '255'), seconds);
    if (!context.replaying) await waitSeconds(seconds, context.token);
  }
}

class AsyncSubimageFadeCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const seconds = args.float(4, 0);
    const options = this.asyncOptions(args, 5, 6, 1, seconds);
    return this.runAsync(context, command, options, async () => {
      context.models.scene.fadeSubImage(args.string(1), args.string(2, '255'), args.string(3, '255'), seconds);
    });
  }
}

class SubimageDeleteCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    context.models.scene.deleteSubImage(args.string(1));
  }
}

class AsyncSubimageDeleteCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const options = this.asyncOptions(args, 2, 3, 1, 0);
    return this.runAsync(context, command, options, async () => {
      context.models.scene.deleteSubImage(args.string(1));
    });
  }
}

class BgCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    context.models.scene.setBackground(args.string(1), args.on(2, true));
  }
}

class BgColorCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const seconds = args.float(5, 0);
    context.models.scene.setBackgroundColor(args.string(1, '0'), args.string(2, '0'), args.string(3, '0'), args.string(4, '255'), seconds);
    if (!context.replaying) await waitSeconds(seconds, context.token);
  }
}

class AsyncBgColorCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const seconds = args.float(5, 0);
    const options = this.asyncOptions(args, 6, 7, -1, seconds);
    return this.runAsync(context, command, options, async () => {
      context.models.scene.setBackgroundColor(args.string(1, '0'), args.string(2, '0'), args.string(3, '0'), args.string(4, '255'), seconds);
    });
  }
}

class CameraMoveCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const seconds = args.float(4, 1);
    context.models.scene.moveCamera(args.string(1, 'Set'), args.string(2, 'X'), args.float(3, 1), seconds);
    if (!context.replaying) await waitSeconds(seconds, context.token);
  }
}

class AsyncCameraMoveCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const seconds = args.float(4, 1);
    const options = this.asyncOptions(args, 5, 6, -1, seconds);
    return this.runAsync(context, command, options, async () => {
      context.models.scene.moveCamera(args.string(1, 'Set'), args.string(2, 'X'), args.float(3, 1), seconds);
    });
  }
}

class CameraZoomCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const seconds = args.float(2, 1);
    context.models.scene.zoomCamera(args.float(1, 1), seconds, args.string(3, 'Set'));
    if (!context.replaying) await waitSeconds(seconds, context.token);
  }
}

class AsyncCameraZoomCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const seconds = args.float(2, 1);
    const options = this.asyncOptions(args, 4, 5, -1, seconds);
    return this.runAsync(context, command, options, async () => {
      context.models.scene.zoomCamera(args.float(1, 1), seconds, args.string(3, 'Set'));
    });
  }
}

class MoveCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const seconds = args.float(3, 1);
    context.models.scene.moveTarget(args.string(1), args.string(2), seconds, args.float(4, 0), args.float(5, 0), args.string(6, 'Set'));
    if (!context.replaying) await waitSeconds(seconds, context.token);
  }
}

class AsyncMoveCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const seconds = args.float(3, 1);
    const options = this.asyncOptions(args, 7, 8, 2, seconds);
    return this.runAsync(context, command, options, async () => {
      context.models.scene.moveTarget(args.string(1), args.string(2), seconds, args.float(4, 0), args.float(5, 0), args.string(6, 'Set'));
    });
  }
}

class ScaleCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const seconds = args.float(3, 1);
    context.models.scene.scaleTarget(args.string(1), args.string(2), seconds, args.float(4, 0), args.float(5, 0), args.string(6, 'Set'));
    if (!context.replaying) await waitSeconds(seconds, context.token);
  }
}

class AsyncScaleCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const seconds = args.float(3, 1);
    const options = this.asyncOptions(args, 7, 8, 2, seconds);
    return this.runAsync(context, command, options, async () => {
      context.models.scene.scaleTarget(args.string(1), args.string(2), seconds, args.float(4, 0), args.float(5, 0), args.string(6, 'Set'));
    });
  }
}

class JumpCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const seconds = args.float(4, 1);
    const count = args.int(5, 1);
    const loop = args.on(6, false);
    context.models.scene.jumpTarget(args.string(1), args.string(2), args.float(3, 0), seconds, count, loop);
    context.models.scene.render();
    if (!context.replaying && !loop) await waitSeconds(seconds * Math.max(1, count), context.token);
  }
}

class AsyncJumpCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const tag = args.string(2);
    const seconds = args.float(4, 1);
    const count = args.int(5, 1);
    const loop = args.on(6, false);
    if (loop) context.models.async.stop(tag);
    return this.runAsync(
      context,
      command,
      this.asyncOptions(args, 8, 7, 2, loop ? 0 : seconds * Math.max(1, count)),
      async () => context.models.scene.jumpTarget(args.string(1), tag, args.float(3, 0), seconds, count, loop),
    );
  }
}

class JumpStopCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    context.models.scene.stopJumpTarget(args.string(1), args.string(2));
  }
}

class ShakeCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const seconds = args.float(5, 0);
    const count = args.int(6, 1);
    const loop = args.on(8, false);
    const shakeKind = args.int(9, 0);
    context.models.scene.shakeTarget(args.string(1), args.string(2), args.float(3, 0), args.float(4, 0), seconds, count, args.on(7, false), loop, shakeKind, args.on(10, false));
    if (!context.replaying && !loop) await waitSeconds(seconds, context.token);
  }
}

class AsyncShakeCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const seconds = args.float(5, 0);
    const count = args.int(6, 1);
    const loop = args.on(8, false);
    const shakeKind = args.int(9, 0);
    const options = this.asyncOptions(args, 11, 12, 2, loop ? 0 : seconds);
    return this.runAsync(context, command, options, async () => {
      context.models.scene.shakeTarget(args.string(1), args.string(2), args.float(3, 0), args.float(4, 0), seconds, count, args.on(7, false), loop, shakeKind, args.on(10, false));
    });
  }
}

class ShakeAllCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const seconds = args.float(5, 0);
    const count = args.int(4, 1);
    const loop = args.on(8, false);
    const shakeKind = args.int(7, 0);
    context.models.scene.shakeAll(args.float(1, 0), args.float(2, 0), args.float(3, 0), count, seconds, args.on(6, false), shakeKind, loop);
    if (!context.replaying && !loop) await waitSeconds(seconds, context.token);
  }
}

class AsyncShakeAllCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const seconds = args.float(5, 0);
    const count = args.int(4, 1);
    const loop = args.on(8, false);
    const shakeKind = args.int(7, 0);
    const options = this.asyncOptions(args, 9, 10, -1, loop ? 0 : seconds);
    return this.runAsync(context, command, options, async () => {
      context.models.scene.shakeAll(args.float(1, 0), args.float(2, 0), args.float(3, 0), count, seconds, args.on(6, false), shakeKind, loop);
    });
  }
}

class ShakeAllStopCommand extends NovelCommandBase {
  async onExecute(context) {
    context.models.scene.stopShakeAll();
  }
}

class PrefabLoadCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    context.models.scene.loadPrefab(args.string(1), args.string(2), args.string(3), args.int(4, 0), args.string(5, ''), args.string(6, ''));
  }
}

class PrefabShowCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const seconds = args.float(3, 1);
    context.models.scene.showPrefab(args.string(1), args.on(2, true), seconds, args.float(4, 0), args.float(5, 0), args.string(6, ''));
    if (!context.replaying) await waitSeconds(seconds, context.token);
  }
}

class AsyncPrefabShowCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const options = this.asyncOptions(args, 2, 3, -1, 0);
    return this.runAsync(context, command, options, async () => {
      context.models.scene.showPrefab(args.string(1), true, 0, args.float(4, 0), args.float(5, 0), args.string(6, ''));
    });
  }
}

class PrefabHideAllCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    context.models.scene.showPrefabAll(args.string(1), '', false, 0, 0, '');
  }
}

class AsyncPrefabHideAllCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const options = this.asyncOptions(args, 2, 3, -1, 0);
    return this.runAsync(context, command, options, async () => {
      context.models.scene.showPrefabAll(args.string(1), '', false, 0, 0, '');
    });
  }
}

class PrefabLoadUiCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    context.models.scene.loadPrefabUi(args.string(1), args.string(2), args.string(3), args.int(4, 0), args.string(5, ''), args.string(6, ''));
  }
}

class PrefabShowUiCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    context.models.scene.showPrefabUi(args.string(1), args.on(2, true), 0);
  }
}

class AsyncPrefabShowUiCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const options = this.asyncOptions(args, 4, 5, -1, 0);
    return this.runAsync(context, command, options, async () => {
      context.models.scene.showPrefabUi(args.string(1), args.on(2, true), 0);
    });
  }
}

class PrefabShowAllCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const seconds = args.float(4, 0);
    context.models.scene.showPrefabAll(args.string(1), args.string(2), args.on(3, true), seconds, args.float(5, 0), args.string(6, ''));
    if (!context.replaying) await waitSeconds(seconds, context.token);
  }
}

class AsyncPrefabShowAllCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const options = this.asyncOptions(args, 4, 5, 1, 0);
    return this.runAsync(context, command, options, async () => {
      context.models.scene.showPrefabAll(args.string(1), args.string(2), args.on(3, true), 0, args.float(6, 0), args.string(7, ''));
    });
  }
}

class PrefabDeleteUiCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    context.models.scene.deletePrefabUi(args.string(1));
  }
}

class PrefabDeleteCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    context.models.scene.deletePrefab(args.string(1));
  }
}

class PrefabDeleteAllCommand extends NovelCommandBase {
  async onExecute(context) {
    context.models.scene.deletePrefabAll();
  }
}

class ItemCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    context.models.scene.showItem(args.on(1, true), args.string(2));
  }
}

class SePlayIngameCommand extends NovelCommandBase {
  async onExecute(context, command, args) {
    const tag = args.string(1, 'se');
    const cue = args.string(3, args.string(2, ''));
    const fadeInSeconds = args.float(4, .75);
    const volume = args.float(5, 1);
    if (context.replaying) return;
    context.models.sound.play(cue, 'se', tag, { volume, fadeInSeconds });
  }
}

class AsyncSePlayIngameCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const tag = args.string(1, 'se');
    const cue = args.string(3, args.string(2, ''));
    const fadeInSeconds = args.float(4, .75);
    const volume = args.float(5, 1);
    const options = this.asyncOptions(args, 6, 7, 1, 0);
    return this.runAsync(context, command, options, async () => {
      if (context.replaying) return;
      context.models.sound.play(cue, 'se', tag, { volume, fadeInSeconds });
    });
  }
}

class AsyncCharaMoveCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const moveType = args.string(2, 'Set');
    const duration = normalizeCharaMoveType(moveType) === 'set' ? 0 : args.float(5, 1);
    const options = this.asyncOptions(args, 6, 7, 1, duration);
    return this.runAsync(context, command, options, async () => {
      context.models.scene.moveCharacter(args.string(1), moveType, args.string(3), args.float(4, 0), duration);
    });
  }
}

class AsyncCharaScaleCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const duration = args.float(3, 0);
    const options = this.asyncOptions(args, 4, 5, 1, duration);
    return this.runAsync(context, command, options, async () => {
      context.models.scene.scaleCharacter(args.string(1), args.float(2, 1), duration);
    });
  }
}

class AsyncCharaShowCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const duration = args.float(2, .25);
    const options = this.asyncOptions(args, 3, 4, -1, duration);
    return this.runAsync(context, command, options, async () => {
      context.models.scene.showCharacter(args.string(1), duration, 1);
    });
  }
}

class AsyncCharaShowAlphaCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const duration = args.float(3, .25);
    const options = this.asyncOptions(args, 4, 5, -1, duration);
    return this.runAsync(context, command, options, async () => {
      context.models.scene.showCharacter(args.string(1), duration, args.float(2, 1));
    });
  }
}

class AsyncCharaHideCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const duration = args.float(2, .25);
    const options = this.asyncOptions(args, 3, 4, -1, duration);
    return this.runAsync(context, command, options, async () => {
      context.models.scene.hideCharacter(args.string(1), duration);
    });
  }
}

class AsyncCharaFaceCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const options = this.asyncOptions(args, 3, 4, -1, 0);
    return this.runAsync(context, command, options, async () => {
      context.models.scene.faceCharacter(args.string(1), args.string(2));
    });
  }
}

class AsyncCharaEmoCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const tag = args.string(1);
    const options = this.asyncOptions(args, 3, 4, -1, 0);
    return this.runAsync(context, command, options, async () => {
      const duration = context.models.scene.emotionCharacter(tag, args.string(2));
      context.models.scene.render();
      if (context.isReplayTarget(command)) return;
      if (context.replaying) {
        context.models.scene.clearEmotion(tag);
        return;
      }
      await waitAsyncSeconds(duration, context.asyncToken);
      context.models.scene.clearEmotion(tag);
    });
  }
}

class AsyncCharaReactionCommand extends NovelCommandAsyncBase {
  async onExecute(context, command, args) {
    const duration = args.float(3, 1);
    const options = this.asyncOptions(args, 4, 5, -1, duration);
    return this.runAsync(context, command, options, async () => {
      context.models.scene.reactCharacter(args.string(1), args.string(2), duration);
    });
  }
}

function buildCommandRegistry() {
  return new NovelCommandRegistry()
    .register(':label', new LabelCommand())
    .register('labeljump', new LabelJumpCommand())
    .register('plot', new PlotCommand())
    .register('endof', new EndOfCommand())
    .register('wait', new WaitCommand())
    .register('waitorclick', new WaitOrClickCommand())
    .register('asyncwait', new AsyncWaitCommand())
    .register('asyncskipwait', new AsyncSkipWaitCommand())
    .register('asyncstopwait', new AsyncStopWaitCommand())
    .register('cleanall', new CleanAllCommand())
    .register('cleanskip', new CleanSkipCommand())
    .register('initend', new NoopCommand())
    .register('message', new MessageCommand())
    .register('l2dmessage', new L2DMessageCommand())
    .register('messagetextcenter', new MessageTextCenterCommand())
    .register('messagetextunder', new MessageTextUnderCommand())
    .register('title', new TitleCommand())
    .register('window', new WindowCommand())
    .register('messagetextwindow', new MessageTextWindowCommand())
    .register('uivisible', new UiVisibleCommand())
    .register('adultui', new AdultUiCommand())
    .register('linework', new LineworkCommand())
    .register('fade', new FadeCommand())
    .register('asyncfade', new AsyncFadeCommand())
    .register('crossfadeready', new CrossFadeReadyCommand())
    .register('asynccrossfadeready', new AsyncCrossFadeReadyCommand())
    .register('crossfade', new CrossFadeCommand())
    .register('asynccrossfade', new AsyncCrossFadeCommand())
    .register('colorfade', new ColorFadeCommand())
    .register('asynccolorfade', new AsyncColorFadeCommand())
    .register('transitioncrossfadeready', new TransitionCrossFadeReadyCommand())
    .register('asynctransitioncrossfadeready', new AsyncTransitionCrossFadeReadyCommand())
    .register('transitioncrossfade', new TransitionCrossFadeCommand())
    .register('asynctransitioncrossfade', new AsyncTransitionCrossFadeCommand())
    .register('transitionfade', new TransitionFadeCommand())
    .register('asynctransitionfade', new AsyncTransitionFadeCommand())
    .register('blur', new BlurCommand())
    .register('asyncblur', new AsyncBlurCommand())
    .register('screeneffect', new ScreenEffectCommand())
    .register('asyncscreeneffect', new AsyncScreenEffectCommand())
    .register('live2dinit', new Live2DInitCommand())
    .register('l2dshow', new L2DShowCommand())
    .register('l2dhide', new L2DHideCommand())
    .register('l2dlipsyncmode', new L2DLipSyncModeCommand())
    .register('l2dmotion', new L2DMotionCommand())
    .register('asyncl2dmotion', new AsyncL2DMotionCommand())
    .register('asyncl2dhide', new AsyncL2DHideCommand())
    .register('bgmplay', new BgmPlayCommand())
    .register('asyncbgmplay', new AsyncBgmPlayCommand())
    .register('bgmplayworkunit', new BgmPlayWorkunitCommand())
    .register('asyncbgmplayworkunit', new AsyncBgmPlayWorkunitCommand())
    .register('bgmfade', new BgmFadeCommand())
    .register('asyncbgmfade', new AsyncBgmFadeCommand())
    .register('bgmstop', new BgmStopCommand())
    .register('asyncbgmstop', new AsyncBgmStopCommand())
    .register('bgvplay', new BgvPlayCommand())
    .register('bgvfade', new BgvFadeCommand())
    .register('bgvstop', new BgvStopCommand())
    .register('loadvoice', new LoadVoiceCommand())
    .register('voice', new VoiceCommand())
    .register('voicestop', new VoiceStopCommand())
    .register('seplay', new SePlayCommand())
    .register('asyncseplay', new AsyncSePlayCommand())
    .register('sefade', new SeFadeCommand())
    .register('asyncsefade', new AsyncSeFadeCommand())
    .register('seplayingame', new SePlayIngameCommand())
    .register('asyncseplayingame', new AsyncSePlayIngameCommand())
    .register('sestop', new SeStopCommand())
    .register('asyncsestop', new AsyncSeStopCommand())
    .register('charaload', new CharaloadCommand())
    .register('charadelete', new CharaDeleteCommand())
    .register('charaemo', new CharaEmoCommand())
    .register('charaface', new CharaFaceCommand())
    .register('charafocuson', new CharaFocusOnCommand())
    .register('charafocusout', new CharaFocusOutCommand())
    .register('charafocusoutall', new CharaFocusOutAllCommand())
    .register('charapose', new CharaPoseCommand())
    .register('charamove', new CharaMoveCommand())
    .register('charamask', new CharaMaskCommand())
    .register('charaitem', new CharaItemCommand())
    .register('charareaction', new CharaReactionCommand())
    .register('charascale', new CharaScaleCommand())
    .register('characolor', new CharaColorCommand())
    .register('charashow', new CharaShowCommand())
    .register('charahide', new CharaHideCommand())
    .register('charashowalpha', new CharaShowAlphaCommand())
    .register('charafocusonall', new CharaFocusOnAllCommand())
    .register('defaultcharacolor', new DefaultCharaColorCommand())
    .register('emodelete', new EmoDeleteCommand())
    .register('bg', new BgCommand())
    .register('bgcolor', new BgColorCommand())
    .register('asyncbgcolor', new AsyncBgColorCommand())
    .register('cameramove', new CameraMoveCommand())
    .register('asynccameramove', new AsyncCameraMoveCommand())
    .register('camerazoom', new CameraZoomCommand())
    .register('asynccamerazoom', new AsyncCameraZoomCommand())
    .register('move', new MoveCommand())
    .register('asyncmove', new AsyncMoveCommand())
    .register('scale', new ScaleCommand())
    .register('asyncscale', new AsyncScaleCommand())
    .register('priority', new PriorityCommand())
    .register('stillload', new StillLoadCommand())
    .register('stillchange', new StillChangeCommand())
    .register('asyncstillchange', new AsyncStillChangeCommand())
    .register('stillshow', new StillShowCommand())
    .register('asyncstillshow', new AsyncStillShowCommand())
    .register('stillhide', new StillHideCommand())
    .register('asyncstillhide', new AsyncStillHideCommand())
    .register('stilldelete', new StillDeleteCommand())
    .register('asyncstilldelete', new AsyncStillDeleteCommand())
    .register('subimage', new SubimageCommand())
    .register('subimagefade', new SubimageFadeCommand())
    .register('asyncsubimagefade', new AsyncSubimageFadeCommand())
    .register('subimagedelete', new SubimageDeleteCommand())
    .register('asyncsubimagedelete', new AsyncSubimageDeleteCommand())
    .register('prefabload', new PrefabLoadCommand())
    .register('prefabshow', new PrefabShowCommand())
    .register('asyncprefabshow', new AsyncPrefabShowCommand())
    .register('prefabhideall', new PrefabHideAllCommand())
    .register('asyncprefabhideall', new AsyncPrefabHideAllCommand())
    .register('prefabloadui', new PrefabLoadUiCommand())
    .register('prefabuiload', new PrefabLoadUiCommand())
    .register('prefabshowui', new PrefabShowUiCommand())
    .register('asyncprefabshowui', new AsyncPrefabShowUiCommand())
    .register('prefabshowall', new PrefabShowAllCommand())
    .register('asyncprefabshowall', new AsyncPrefabShowAllCommand())
    .register('prefabdelete', new PrefabDeleteCommand())
    .register('prefabdeleteall', new PrefabDeleteAllCommand())
    .register('prefabdeleteui', new PrefabDeleteUiCommand())
    .register('item', new ItemCommand())
    .register('jump', new JumpCommand())
    .register('jumpstop', new JumpStopCommand())
    .register('shake', new ShakeCommand())
    .register('shakeall', new ShakeAllCommand())
    .register('asyncshakeall', new AsyncShakeAllCommand())
    .register('shakeallstop', new ShakeAllStopCommand())
    .register('asyncjump', new AsyncJumpCommand())
    .register('asyncshake', new AsyncShakeCommand())
    .register('asynccharamove', new AsyncCharaMoveCommand())
    .register('asynccharascale', new AsyncCharaScaleCommand())
    .register('asynccharacolor', new AsyncCharaColorCommand())
    .register('asynccharapose', new AsyncCharaPoseCommand())
    .register('asynccharadelete', new AsyncCharaDeleteCommand())
    .register('asynccharafocuson', new AsyncCharaFocusOnCommand())
    .register('asynccharafocusonall', new AsyncCharaFocusOnAllCommand())
    .register('asynccharafocusout', new AsyncCharaFocusOutCommand())
    .register('asynccharafocusoutall', new AsyncCharaFocusOutAllCommand())
    .register('asynccharamask', new AsyncCharaMaskCommand())
    .register('asynccharaitem', new AsyncCharaItemCommand())
    .register('asynccharashow', new AsyncCharaShowCommand())
    .register('asynccharashowalpha', new AsyncCharaShowAlphaCommand())
    .register('asynccharahide', new AsyncCharaHideCommand())
    .register('asynccharaface', new AsyncCharaFaceCommand())
    .register('asynccharaemo', new AsyncCharaEmoCommand())
    .register('asynccharareaction', new AsyncCharaReactionCommand());
}

function isTextPauseCommand(commandName) {
  return new Set(['message', 'l2dmessage', 'messagetextcenter', 'messagetextunder', 'title']).has(String(commandName || '').toLowerCase());
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function fetchJsonOptional(url, fallback) {
  try {
    return await fetchJson(url);
  } catch (_) {
    return fallback;
  }
}

function baseCommandName(commandName) {
  const name = String(commandName || '').toLowerCase();
  return name.startsWith('async') ? name.slice(5) : name;
}

function parseAsyncMode(value) {
  return String(value || '').trim().toUpperCase() === 'STOP' ? 'STOP' : 'CONT';
}

function parseOnOff(value, fallback = false) {
  const text = String(value ?? '').trim().toLowerCase();
  if (['on', 'true', '1'].includes(text)) return true;
  if (['off', 'false', '0'].includes(text)) return false;
  return fallback;
}

function normalizeTargetType(value) {
  const key = normalizeAssetKey(value);
  if (['back', 'bg', 'background'].includes(key)) return 'back';
  if (['chara', 'character'].includes(key)) return 'chara';
  if (['subimage', 'still'].includes(key)) return 'subimage';
  if (['prefab', 'prefabui', 'ui', 'other'].includes(key)) return 'prefabui';
  return key || 'object';
}

function byteToUnit(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  if (numeric > 1) return clamp(numeric / 255, 0, 1);
  return clamp(numeric, 0, 1);
}

function normalizeAlpha(value) {
  return byteToUnit(value);
}

function rgbaByte(r, g, b, alpha = 255) {
  const rr = clamp(Math.round(Number(r) || 0), 0, 255);
  const gg = clamp(Math.round(Number(g) || 0), 0, 255);
  const bb = clamp(Math.round(Number(b) || 0), 0, 255);
  return `rgba(${rr},${gg},${bb},${byteToUnit(alpha)})`;
}

function rgbaFloat(r, g, b, alpha = 1) {
  const rr = clamp(Number(r) || 0, 0, 1) * 255;
  const gg = clamp(Number(g) || 0, 0, 1) * 255;
  const bb = clamp(Number(b) || 0, 0, 1) * 255;
  return `rgba(${rr},${gg},${bb},${clamp(Number(alpha) || 0, 0, 1)})`;
}

function easingToCss(value) {
  const key = normalizeAssetKey(value || 'linear');
  if (key.includes('easeinout')) return 'ease-in-out';
  if (key.includes('easein')) return 'ease-in';
  if (key.includes('easeout')) return 'ease-out';
  return 'linear';
}

function screenEffectFilter(effect, value) {
  const key = normalizeAssetKey(effect);
  const amount = Number.isFinite(Number(value)) ? Number(value) : 1;
  if (key === 'bloom') return `brightness(${1 + Math.max(0, amount) * 0.08}) saturate(${1 + Math.max(0, amount) * 0.12})`;
  if (key.includes('blur')) return `blur(${Math.max(0, amount) * 4}px)`;
  if (key.includes('gray') || key.includes('mono')) return 'grayscale(1)';
  if (key.includes('sepia')) return 'sepia(1)';
  if (key.includes('invert')) return 'invert(1)';
  return `brightness(${1 + Math.max(0, amount) * 0.04})`;
}

function characterFilter(item) {
  const parts = [];
  if (item.focus === false) parts.push('brightness(.62) saturate(.82)');
  if (item.color) {
    const a = normalizeAlpha(item.color.alpha);
    const brightness = (0.2126 * byteToUnit(item.color.r)) + (0.7152 * byteToUnit(item.color.g)) + (0.0722 * byteToUnit(item.color.b));
    parts.push(`brightness(${clamp(brightness * 1.8, 0.05, 2)}) opacity(${a})`);
  }
  return parts.join(' ');
}

function mergeTransition(current, nextTransformTransition) {
  const kept = String(current || '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith('transform '));
  kept.push(nextTransformTransition);
  return kept.join(', ');
}

function resolveSceneAssetImage(asset) {
  return resolveSceneAssetInfo(asset).src;
}

function resolveSceneAssetInfo(asset) {
  const text = String(asset || '');
  const leaf = assetLeaf(text);
  const bgKey = normalizeAssetKey(leaf);
  if (/^abg\d+[a-z]?$/i.test(leaf) || /ui\/bg\/novel/i.test(text)) {
    const meta = app.backgroundAssets.get(bgKey);
    const width = Number(meta?.width) || 0;
    const height = Number(meta?.height) || 0;
    return {
      src: `${BG_DATA_ROOT}${bgKey}.png`,
      width,
      height,
      fullFrame: width >= 512 && height >= 512,
    };
  }
  return { src: '', width: 0, height: 0, fullFrame: false };
}

function assetLeaf(asset) {
  return String(asset || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

function normalizeAssetKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizeAudioCueKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '');
}

function screenBlurTargetLayers(target) {
  if (target === 'back' || target === 'bg' || target === 'background') return [el.bgLayer];
  if (target === 'chara' || target === 'character') return [el.sceneLayer];
  if (target === 'l2d' || target === 'live2d') return [el.live2dCanvas, el.fallbackTexture];
  return [el.bgLayer, el.live2dCanvas, el.fallbackTexture, el.sceneLayer];
}

function normalizeCharaFace(value) {
  const key = normalizeAssetKey(value);
  if (!key) return 'normal';
  if (key === 'eyeclose') return 'closed';
  if (key === 'eyeopen') return 'eyeopen';
  if (key.startsWith('face')) return key.slice(4) || 'normal';
  return key;
}

function currentCharaFaceKey(item) {
  if (item.eyeClosed && item.asset?.faces?.closed) return 'closed';
  return item.baseFace || 'normal';
}

function resolveCharaMoveParameter(parameter, value, character) {
  const key = normalizeAssetKey(parameter);
  const numeric = Number(value);
  const finalValue = Number.isFinite(numeric) ? numeric : 0;
  if (key === 'x') return { axis: 'x', value: finalValue };
  if (key === 'y') return { axis: 'y', value: finalValue };
  if (key === 'leftd') return { axis: 'x', value: finalValue - 200 };
  if (key === 'rightd') return { axis: 'x', value: finalValue + 200 };
  if (key === 'leftt') return { axis: 'x', value: finalValue - 300 };
  if (key === 'rightt') return { axis: 'x', value: finalValue + 300 };
  if (key === 'charaheight') return { axis: 'y', value: characterDefaultHeight(character) + finalValue };
  return { axis: 'x', value: finalValue };
}

function normalizeCharaMoveType(value) {
  return normalizeAssetKey(value || 'set');
}

function resolveCharaMoveValue(moveType, value, current) {
  const type = normalizeCharaMoveType(moveType);
  const original = Number(current);
  const base = Number.isFinite(original) ? original : 0;
  const amount = Number.isFinite(Number(value)) ? Number(value) : 0;
  if (type === 'set' || type === 'lineartarget' || type === 'easeintarget' || type === 'easeouttarget') {
    return { value: amount, instant: type === 'set' };
  }
  if (type === 'add' || type === 'linear' || type === 'easein' || type === 'easeout') {
    return { value: base + amount, instant: type === 'add' };
  }
  return { value: base, instant: true };
}

function charaMoveEasing(value) {
  const type = normalizeCharaMoveType(value);
  if (type === 'easein' || type === 'easeintarget') return 'ease-in';
  if (type === 'easeout') return 'ease-out';
  if (type === 'easeouttarget') return 'ease-out';
  return 'linear';
}

function characterDefaultHeight(character) {
  const value = Number(character?.asset?.defaultHeight ?? character?.defaultHeight);
  return Number.isFinite(value) ? value : 0;
}

function rectSize(rect, fallbackX, fallbackY) {
  const size = rect?.sizeDelta || {};
  const x = Number(size.x);
  const y = Number(size.y);
  return {
    x: Number.isFinite(x) && Math.abs(x) > 0.0001 ? Math.abs(x) : fallbackX,
    y: Number.isFinite(y) && Math.abs(y) > 0.0001 ? Math.abs(y) : fallbackY,
  };
}

function rectPosition(rect) {
  const position = rect?.anchoredPosition || {};
  return {
    x: Number(position.x) || 0,
    y: Number(position.y) || 0,
  };
}

function rectWorldPosition(rect) {
  const position = rect?.worldPosition || rect?.anchoredPosition || {};
  return {
    x: Number(position.x) || 0,
    y: Number(position.y) || 0,
  };
}

function rectScale(rect, fallback) {
  const scale = rect?.localScale || {};
  return {
    x: Number(scale.x) || fallback,
    y: Number(scale.y) || fallback,
  };
}

function rectPivot(rect) {
  const pivot = rect?.pivot || {};
  const x = Number(pivot.x);
  const y = Number(pivot.y);
  return {
    x: Number.isFinite(x) ? x : 0.5,
    y: Number.isFinite(y) ? y : 0.5,
  };
}

function emotionAttachmentTransform(asset) {
  const emotionRect = asset?.emotionRect || {};
  const zoomRect = asset?.zoomRect || {};
  return {
    position: rectPosition(emotionRect),
    scale: rectScale(zoomRect, 1),
    pivot: rectPivot(emotionRect),
  };
}

function cssEscape(value) {
  if (window.CSS?.escape) return CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

function isImmediateDelay(value) {
  const seconds = Math.max(0, Number(value) || 0);
  return seconds <= 0.000001;
}

function evaluateMotionCurve(segments, time) {
  if (!Array.isArray(segments) || segments.length < 2) return null;
  let previousTime = Number(segments[0]) || 0;
  let previousValue = Number(segments[1]) || 0;
  if (time <= previousTime) return previousValue;

  let i = 2;
  while (i < segments.length) {
    const type = Number(segments[i++]) || 0;
    if (type === 0 || type === 2 || type === 3) {
      const nextTime = Number(segments[i++]);
      const nextValue = Number(segments[i++]);
      if (!Number.isFinite(nextTime) || !Number.isFinite(nextValue)) break;
      if (time <= nextTime) {
        if (type === 2) return previousValue;
        if (type === 3) return nextValue;
        const span = Math.max(0.000001, nextTime - previousTime);
        const t = clamp((time - previousTime) / span, 0, 1);
        return previousValue + (nextValue - previousValue) * t;
      }
      previousTime = nextTime;
      previousValue = nextValue;
      continue;
    }

    if (type === 1) {
      const cp1Time = Number(segments[i++]);
      const cp1Value = Number(segments[i++]);
      const cp2Time = Number(segments[i++]);
      const cp2Value = Number(segments[i++]);
      const endTime = Number(segments[i++]);
      const endValue = Number(segments[i++]);
      if (!Number.isFinite(endTime) || !Number.isFinite(endValue)) break;
      if (time <= endTime) {
        const span = Math.max(0.000001, endTime - previousTime);
        const t = clamp((time - previousTime) / span, 0, 1);
        return cubicBezierValue(previousValue, cp1Value, cp2Value, endValue, t);
      }
      previousTime = endTime;
      previousValue = endValue;
      continue;
    }

    break;
  }
  return previousValue;
}

function cubicBezierValue(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return (u * u * u * p0) + (3 * u * u * t * p1) + (3 * u * t * t * p2) + (t * t * t * p3);
}

function isAllTag(tag) {
  const key = normalizeKey(tag);
  return key === 'all' || key === '*';
}

function waitSeconds(seconds, token) {
  return waitSecondsWhile(seconds, () => token === app.runToken);
}

function waitAsyncSeconds(seconds, token) {
  return waitSecondsWhile(seconds, () => token === app.asyncToken);
}

function waitFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function waitSecondsWhile(seconds, isActive) {
  const ms = Math.max(0, Number(seconds) || 0) * 1000;
  if (!ms || !isActive()) return Promise.resolve();
  return new Promise((resolve) => {
    const id = setTimeout(resolve, ms);
    const check = () => {
      if (!isActive()) {
        clearTimeout(id);
        resolve();
      } else {
        requestAnimationFrame(check);
      }
    };
    requestAnimationFrame(check);
  });
}

function fadeAudio(audio, targetVolume, seconds, done) {
  const start = audio.volume;
  const end = clamp(targetVolume, 0, 1);
  const duration = Math.max(0, seconds) * 1000;
  if (!duration) {
    audio.volume = end;
    done?.();
    return;
  }
  const started = performance.now();
  const tick = () => {
    const t = clamp((performance.now() - started) / duration, 0, 1);
    audio.volume = start + (end - start) * t;
    if (t < 1) requestAnimationFrame(tick);
    else done?.();
  };
  requestAnimationFrame(tick);
}

function setStatus(text, error = false) {
  el.statusLine.textContent = text || '';
  el.statusLine.style.color = error ? 'var(--danger)' : 'var(--muted)';
}

function pulseFallback() {
  el.fallbackTexture.animate([
    { transform: 'scale(1)' },
    { transform: 'scale(1.018)' },
    { transform: 'scale(1)' },
  ], { duration: 320, easing: 'ease-out' });
}

function resizeOverlayCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round((el.stage.clientWidth || 1) * dpr));
  const height = Math.max(1, Math.round((el.stage.clientHeight || 1) * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return dpr;
}

function pixelateCanvasMesh(source, target, scratch, mesh, blockSize) {
  const rect = mesh.rect || {};
  const x = clamp(rect.x, 0, target.width);
  const y = clamp(rect.y, 0, target.height);
  const width = clamp(rect.width, 0, target.width - x);
  const height = clamp(rect.height, 0, target.height - y);
  if (width <= 1 || height <= 1) return;

  const smallWidth = Math.max(1, Math.ceil(width / Math.max(1, blockSize)));
  const smallHeight = Math.max(1, Math.ceil(height / Math.max(1, blockSize)));
  scratch.width = smallWidth;
  scratch.height = smallHeight;
  const scratchCtx = scratch.getContext('2d', { willReadFrequently: true });
  const targetCtx = target.getContext('2d', { willReadFrequently: true });
  if (!scratchCtx || !targetCtx) return;

  scratchCtx.imageSmoothingEnabled = true;
  scratchCtx.clearRect(0, 0, smallWidth, smallHeight);
  scratchCtx.drawImage(source, x, y, width, height, 0, 0, smallWidth, smallHeight);
  neutralizeMosaicScratch(scratchCtx, smallWidth, smallHeight);

  targetCtx.save();
  buildMeshClipPath(targetCtx, mesh.points, mesh.indices);
  targetCtx.clip();
  targetCtx.imageSmoothingEnabled = false;
  targetCtx.drawImage(scratch, 0, 0, smallWidth, smallHeight, x, y, width, height);
  targetCtx.imageSmoothingEnabled = true;
  targetCtx.restore();
}

function neutralizeMosaicScratch(ctx, width, height) {
  try {
    const image = ctx.getImageData(0, 0, width, height);
    const data = image.data;
    const saturation = 0.12;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      data[i] = gray + (data[i] - gray) * saturation;
      data[i + 1] = gray + (data[i + 1] - gray) * saturation;
      data[i + 2] = gray + (data[i + 2] - gray) * saturation;
    }
    ctx.putImageData(image, 0, 0);
  } catch (_) {}
}

function buildMeshClipPath(ctx, points, indices) {
  ctx.beginPath();
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = points[indices[i]];
    const b = points[indices[i + 1]];
    const c = points[indices[i + 2]];
    if (!a || !b || !c) continue;
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(c.x, c.y);
    ctx.closePath();
  }
}

function buildTransitionSnapshot() {
  const snapshot = document.createElement('div');
  snapshot.className = 'transition-snapshot';
  snapshot.appendChild(cloneTransitionLayer(el.bgLayer, 'transition-bg-copy'));
  const canvasCopy = captureCanvasImage(el.live2dCanvas);
  if (canvasCopy) snapshot.appendChild(canvasCopy);
  const mosaicCopy = captureCanvasImage(el.mosaicLayer);
  if (mosaicCopy) snapshot.appendChild(mosaicCopy);
  snapshot.appendChild(cloneTransitionLayer(el.fallbackTexture, 'transition-fallback-copy'));
  snapshot.appendChild(cloneTransitionLayer(el.sceneLayer, 'transition-scene-copy'));
  snapshot.appendChild(cloneTransitionLayer(el.screenEffectLayer, 'transition-screen-effect-copy'));
  return snapshot;
}

function cloneTransitionLayer(source, extraClass) {
  const clone = source.cloneNode(true);
  stripIds(clone);
  clone.classList.add('transition-layer-copy');
  if (extraClass) clone.classList.add(extraClass);
  clone.style.position = 'absolute';
  clone.style.inset = '0';
  clone.style.pointerEvents = 'none';

  const computed = getComputedStyle(source);
  clone.style.opacity = computed.opacity;
  clone.style.filter = computed.filter === 'none' ? '' : computed.filter;
  clone.style.display = computed.display;
  if (source === el.bgLayer) {
    clone.style.backgroundImage = computed.backgroundImage;
    clone.style.backgroundPosition = computed.backgroundPosition;
    clone.style.backgroundRepeat = computed.backgroundRepeat;
    clone.style.backgroundSize = computed.backgroundSize;
  }
  if (source === el.fallbackTexture) {
    clone.style.width = computed.width;
    clone.style.height = computed.height;
    clone.style.maxWidth = computed.maxWidth;
    clone.style.objectFit = computed.objectFit;
    clone.style.margin = computed.margin;
  }
  return clone;
}

function captureCanvasImage(canvas) {
  if (!canvas || !canvas.width || !canvas.height) return null;
  try {
    const source = canvas.toDataURL('image/png');
    if (!source || source.length < 128) return null;
    const image = document.createElement('img');
    image.className = 'transition-canvas-copy';
    image.src = source;
    return image;
  } catch (_) {
    return null;
  }
}

function stripIds(node) {
  if (node.removeAttribute) node.removeAttribute('id');
  for (const child of Array.from(node.children || [])) stripIds(child);
}

function createEmotionPart(part, index) {
  const image = document.createElement('img');
  image.className = 'scene-character-emotion-part';
  image.alt = '';
  image.dataset.partIndex = String(index);
  image.dataset.src = `${CHARA_EMOTION_ROOT}${part.file}`;
  image.src = image.dataset.src;
  return image;
}

function applyEmotionPartLayout(image, part, unitScale) {
  const position = part?.position || {};
  const size = part?.size || {};
  const pivot = part?.pivot || {};
  const scale = part?.localScale || {};
  const x = Number(position.x) || 0;
  const y = Number(position.y) || 0;
  const width = Math.max(1, Number(size.x) || Number(part?.naturalWidth) || 150);
  const height = Math.max(1, Number(size.y) || Number(part?.naturalHeight) || 150);
  const pivotX = Number.isFinite(Number(pivot.x)) ? Number(pivot.x) : 0.5;
  const pivotY = Number.isFinite(Number(pivot.y)) ? Number(pivot.y) : 0.5;
  const scaleX = Number.isFinite(Number(scale.x)) ? Number(scale.x) : 1;
  const scaleY = Number.isFinite(Number(scale.y)) ? Number(scale.y) : 1;
  image.style.left = `calc(50% + ${x * unitScale}px)`;
  image.style.top = `calc(50% + ${-y * unitScale}px)`;
  image.style.width = `${width * unitScale}px`;
  image.style.height = `${height * unitScale}px`;
  image.style.transform = `translate(${-pivotX * 100}%, ${-(1 - pivotY) * 100}%) scale(${scaleX}, ${scaleY})`;
}

function emotionDurationSeconds(emotion) {
  const asset = app.emotionAssets.get(normalizeAssetKey(emotion));
  return Math.max(0.1, Number(asset?.duration) || 1);
}

function cssColor(value) {
  const text = String(value || 'black').toLowerCase();
  const named = { black: '#000', white: '#fff', clear: 'rgba(0,0,0,0)', transparent: 'rgba(0,0,0,0)' };
  return named[text] || value;
}

function normalizeKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizeMosaicMode(value) {
  const mode = normalizeKey(value || 'original');
  if (mode === 'off' || mode === 'none') return 'off';
  if (mode === 'mosaic' || mode === 'normal') return 'mosaic';
  if (mode === 'inverted' || mode === 'mosaicinvert' || mode === 'mosaicinsted' || mode === 'mosaicinstead') return 'inverted';
  return 'original';
}

function mosaicDrawableMaterial(id) {
  const key = normalizeKey(id);
  if (!key.includes('mosaic') && !key.includes('mozaic')) return '';
  if (key.includes('invert') || key.includes('insted') || key.includes('instead')) return 'inverted';
  return 'mosaic';
}

function mosaicModeLabel(value) {
  const mode = normalizeMosaicMode(value);
  if (mode === 'mosaic') return 'Mosaic_';
  if (mode === 'inverted') return 'MosaicInvert_';
  if (mode === 'off') return 'off';
  return 'Original';
}

function live2dGroupPriority(group) {
  const index = L2D_GROUP_PRIORITY.indexOf(String(group || ''));
  return index >= 0 ? index : L2D_GROUP_PRIORITY.length;
}

function extractLive2DVoiceSuffix(voiceId) {
  const text = String(voiceId || '');
  if (!text) return '';
  const suffix = text.slice(text.lastIndexOf('_') + 1);
  return L2D_LIP_SYNC.suffixPattern.test(suffix) ? suffix : '';
}

function fileBase(path) {
  return String(path || '').split(/[\\/]/).pop().replace(/\.motion3\.json$/i, '');
}

function isNumericText(value) {
  return /^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(String(value || '').trim());
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(start, end, t) {
  return start + (end - start) * t;
}

function smoothStep(t) {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}
