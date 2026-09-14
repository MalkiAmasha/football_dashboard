# Hosting Football Score Table with Docker

Everything the app needs (Node, Express, headless Chromium) is inside the image.
Nothing else has to be installed on the host except Docker.

## Option A — you were sent the `football-score-table-docker` folder

Open a terminal in that folder, then:

```bash
docker load -i football-score-table.tar.gz
docker compose up -d
```

`docker load` reads the gzip directly — no need to unzip it first.

Open <http://localhost:8080> (or `http://<server-ip>:8080` from another machine).

## Option B — you have the source code

```bash
docker compose up -d --build
```

## Managing it

```bash
docker compose logs -f      # follow logs
docker compose restart      # restart
docker compose down         # stop and remove
```

## Configuration

| Setting | Where | Notes |
| --- | --- | --- |
| Port | `ports:` in `docker-compose.yml` | `"9000:8080"` serves it on 9000 instead |
| `SOFA_PROXY` | `environment:` in `docker-compose.yml` | See below |

## If the match list is empty

Sofascore blocks a lot of datacenter and office IP ranges at their edge — every
request comes back `403`. That is a network block, not a bug. Check the logs:

```bash
docker compose logs | grep 403
```

Fix it by hosting from an unblocked network, or by routing the app's traffic
through a residential/mobile proxy — uncomment and fill in `SOFA_PROXY` in
`docker-compose.yml`, then `docker compose up -d`:

```yaml
    environment:
      PORT: "8080"
      SOFA_PROXY: "http://user:pass@host:port"
```

## Notes

- First request after startup takes a few seconds while Chromium warms up.
- The container needs ~1GB RAM; `shm_size: 1gb` in the compose file is required,
  Chromium crashes with Docker's default 64MB `/dev/shm`.
- The container is stateless — no volumes, no database. Restarting loses nothing.
