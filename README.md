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

For the full Android DMM R18 workflow, run the one-shot script:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/run_full_r18.ps1
```

It creates `.venv`, installs pinned Python dependencies, builds `DotAbyssClient`, downloads the full bundle set, extracts all r18 novel stories, extracts shared assets, converts audio to OGG, and verifies Live2D motion files.

For a lightweight connectivity test without downloading bundle payloads:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/run_full_r18.ps1 -DryRun
```

Manual steps are still available.

1. Download the remote catalog and bundle set:

```powershell
dotnet run --project src/DotAbyssClient -- download --profile android-dmm-r18 -o workspace/bundles/android-dmm-r18 --write-catalog-json
```

2. Extract story bundles into the player data folder:

```powershell
.\.venv\Scripts\python.exe tools/adv_extract.py --scan-all --bundle-root workspace/bundles/android-dmm-r18 --output src/AdvPlayer/data_r18_all
```

3. Start the player:

```powershell
python scripts/serve_advplayer.py
```

Then open `http://127.0.0.1:8777/`.

## Legacy Workflow

The older helper remains available, but the full deployment path above is preferred:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/run_r18_workflow.ps1
```

More detail lives in [docs/workflow.md](docs/workflow.md).
