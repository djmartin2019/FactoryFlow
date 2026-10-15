# FactoryFlow — smoke tests and rollback (factoryflow.djm-apps.com)

## Smoke tests (after switching `current`)
- `curl -I https://factoryflow.djm-apps.com/` → 200, `text/html`, `Cache-Control: no-cache`
- `curl -I https://factoryflow.djm-apps.com/data/events.json` → 200, `application/json`
- `curl -I https://factoryflow.djm-apps.com/data/nope.json` → **404** (not HTML)
- Browser: 3D canvas renders, KPI cards populate, play/pause/seek/reset work, station click works
- Operations Explorer: switch tabs while playing, open a work order, seek back (order disappears), reset
- Console/network clean: no failed assets, mixed content or CORS errors; hard refresh loads matching JS + JSON
- Narrow viewport: no catastrophic layout failure; `?perf` overlay toggles
- `sudo tail /var/log/apache2/factoryflow-error.log`; confirm other apps (e.g. birdbrain) still respond

## Rollback
```bash
ls -1t /var/www/factoryflow/releases          # pick the previous known-good id
sudo -u david ln -sfn /var/www/factoryflow/releases/<previous-id> /var/www/factoryflow/current.new
sudo -u david mv -Tf /var/www/factoryflow/current.new /var/www/factoryflow/current
sudo apachectl configtest && sudo systemctl reload apache2
```
Keep the failed release on disk until diagnosed.

## First-time server prep (david, review before running)
```bash
sudo mkdir -p /var/www/factoryflow/releases && sudo chown -R david:david /var/www/factoryflow
```
