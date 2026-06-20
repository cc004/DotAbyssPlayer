# Workflow

This repo uses a simple relative directory layout:

- Bundles and fetched catalogs go under `workspace/bundles/<profile>`
- Extracted player data goes under `src/AdvPlayer/data` and `src/AdvPlayer/data_r18_all`
- Optional external tools live under `tools/bin`

## 1. Download maintenance, catalog, and bundles

The preferred full workflow is:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/run_full_r18.ps1
```

For a network/catalog-only smoke test:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/run_full_r18.ps1 -DryRun
```

`src/DotAbyssClient` is the entry point for the network side of the workflow.

Example:

```powershell
dotnet run --project src/DotAbyssClient -- download `
  --profile android-dmm-r18 `
  --app-version 1.1.2 `
  -o workspace/bundles/android-dmm-r18 `
  --write-catalog-json
```

Outputs:

- `workspace/bundles/android-dmm-r18/_catalog/maintenance.json`
- `workspace/bundles/android-dmm-r18/_catalog/catalog_1.bin`
- `workspace/bundles/android-dmm-r18/_catalog/catalog_1.summary.json`
- `workspace/bundles/android-dmm-r18/download_manifest.tsv`
- Nested bundle files mapped into subdirectories

## 2. Extract story-local player data

`tools/adv_extract.py` turns downloaded bundle trees into player-ready JSON, Live2D assets, textures, and decoded story audio.

Example:

```powershell
python tools/adv_extract.py `
  --scan-all `
  --bundle-root workspace/bundles/android-dmm-r18 `
  --output src/AdvPlayer/data_r18_all
```

Notes:

- `--target` can be repeated if you want to extract only specific story folders
- `--story-prefix 1001` can be added to restrict extraction to a subset; omitting it extracts every discovered r18 novel story
- `--no-audio` skips CRI audio decoding
- `--vgmstream` can point to a custom `vgmstream-cli.exe`

## 3. Extract shared assets used by the player

The player expects a few shared asset indexes outside individual story folders.

Character stands:

```powershell
python tools/extract_charastand_assets.py
```

Backgrounds:

```powershell
python tools/extract_bg_assets.py
```

Shared SE:

```powershell
python tools/extract_global_se_assets.py --story-root src/AdvPlayer/data_r18_all/stories
```

WAV to OGG:

```powershell
python tools/convert_wav_audio_to_ogg.py
```

## 4. Run the web player

Serve `src/AdvPlayer` with any static server. The bundled helper uses Python:

```powershell
python scripts/serve_advplayer.py
```

## 5. Verify extracted data

The full workflow runs this automatically after extraction:

```powershell
.\.venv\Scripts\python.exe tools/verify_advplayer_data.py --data-root src/AdvPlayer/data_r18_all
```

## 6. Common directories intentionally excluded from git

- `workspace/`
- `src/AdvPlayer/data/`
- `src/AdvPlayer/data_r18_all/`
- `tools/bin/`
- `.NET bin/obj`
