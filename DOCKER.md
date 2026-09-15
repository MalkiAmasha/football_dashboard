# Hosting Football Score Table with Docker

Everything the app needs (Node, Express, headless Chromium) is inside the image
on Docker Hub: **[malkiamasha/football-score-table](https://hub.docker.com/r/malkiamasha/football-score-table)**.
The host only needs Docker.

## Start it

With Docker Compose, from this repo's folder:

```bash
docker compose up -d
```

Or with plain Docker, no repo needed:

```bash
docker run -d --name football-score-table --restart unless-stopped \
  -p 8080:8080 --shm-size=1gb --init \
  malkiamasha/football-score-table
```

Open <http://localhost:8080>, or `http://<server-ip>:8080` from another machine.

## Managing it

```bash
docker compose logs -f      # follow logs
docker compose restart      # restart
docker compose down         # stop and remove
docker compose pull && docker compose up -d   # update to the newest image
```

## Building the image from source

```bash
docker compose up -d --build
```

To publish a new version to Docker Hub (needs `docker login` as `malkiamasha`):

```bash
docker build -t malkiamasha/football-score-table .
docker push malkiamasha/football-score-table
```

Only the `latest` tag is used, so a push replaces the previous image.

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

To test a proxy before using it, from a copy of this repo (needs Node.js; run
`npm install` first):

```bash
npm run check-ip -- http://user:pass@host:port
```

## Notes

- First request after startup takes a few seconds while Chromium warms up.
- The container needs ~1GB RAM; `shm_size: 1gb` in the compose file is required,
  Chromium crashes with Docker's default 64MB `/dev/shm`.
- The container is stateless — no volumes, no database. Restarting loses nothing.
