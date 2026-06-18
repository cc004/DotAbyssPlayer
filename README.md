# DotAbyssPlayer

`DotAbyssPlayer` collects the catalog download flow, bundle download flow, bundle-to-player extraction tools, and the web ADV player source in one repo-shaped folder.

This folder intentionally does not include:

- Downloaded catalogs or bundles
- Extracted player data
- Third-party binary tools such as `vgmstream-cli.exe`
- Local absolute paths or machine-specific build output

## Layout

- `src/DotAbyssClient`: .NET 8 downloader for maintenance lookup, catalog fetch, catalog parse, manifest generation, and bundle download
- `src/AdvPlayer`: static web ADV player source
- `tools`: Python extraction and post-processing tools
- `scripts`: convenience scripts for the common workflow
- `docs`: workflow notes

## Requirements

- .NET 8 SDK
- Python 3.10+
- `pip install -r requirements.txt`
- Optional: `vgmstream-cli.exe` placed under `tools/bin/vgmstream/` or available on `PATH`

## Quick start

1. Download the remote catalog and bundle set:

```powershell
dotnet run --project src/DotAbyssClient -- download --profile android-dmm-r18 -o workspace/bundles/android-dmm-r18 --write-catalog-json
```

2. Extract story bundles into the player data folder:

```powershell
python tools/adv_extract.py --scan-all --bundle-root workspace/bundles/android-dmm-r18 --output src/AdvPlayer/data_r18_all
```

3. Extract shared character, background, and SE assets:

```powershell
python tools/extract_charastand_assets.py --story-root src/AdvPlayer/data_r18_all/stories
python tools/extract_bg_assets.py --story-root src/AdvPlayer/data_r18_all/stories
python tools/extract_global_se_assets.py --story-root src/AdvPlayer/data_r18_all/stories
python tools/convert_wav_audio_to_ogg.py
```

4. Start the player:

```powershell
python scripts/serve_advplayer.py
```

Then open `http://127.0.0.1:8777/`.

## One-shot workflow

For the common Android DMM R18 flow, use:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/run_r18_workflow.ps1
```

More detail lives in [docs/workflow.md](docs/workflow.md).
