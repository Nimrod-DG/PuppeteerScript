## Antrean Bot (Logam Mulia)

### Requirements
- Docker installed and running.

### Build image
```bash
docker build -t antrean-bot .
```

### Run container
```bash
docker run --rm -v "$(pwd)/debug_out:/app/debug_out" antrean-bot
```

### Debug output
- Screenshots and HTML dumps are written under `debug_out/DD-MM-YYYY/`.

