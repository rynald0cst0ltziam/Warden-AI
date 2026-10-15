
## Offline / air-gapped note (added)

Warden is designed to work locally-first. Semantic memory search may download a small (quantized) embedding model on first use and cache it under `~/.warden/models/` so future recalls are local and fast. To avoid unexpected network activity in restricted or air-gapped environments, Warden supports an explicit opt-out:

```bash
# disable automatic embedding model downloads for this session
export WARDEN_NO_EMBEDDINGS=1
# or on Windows PowerShell
$env:WARDEN_NO_EMBEDDINGS = '1'
```

When this flag is set, Warden permanently disables embeddings for the current process/session and falls back to FTS5-only keyword search. You can pre-seed the model cache by placing the model files under `~/.warden/models/` before starting Warden; if present, Warden will use the local files without attempting a download.

If the embedding model is not available and WARDEN_NO_EMBEDDINGS is not set, Warden will attempt a one-time download on first use of semantic memory. In the package postinstall hook we intentionally disable embedding downloads (to avoid surprising enterprise installs); run `warden init` manually when you're ready to allow the model to download.
