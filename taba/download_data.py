# /// script
# requires-python = ">=3.10"
# ///
"""Download the full Israeli cadastre (Gush/Helka) from govmap's public GeoServer WFS,
then split it into 2km grid tiles the web app can fetch on demand.

Endpoint discovered from www.govmap.gov.il network traffic:
  https://www.govmap.gov.il/api/geoserver/ows/public/  (GeoServer WMS+WFS proxy)
Layers:
  govmap:layer_parcel_all   - all parcels (Helkot), ~1.1M features
  govmap:layer_sub_gush_all - all blocks (Gushim), ~18.7K features

Data is fetched in the native EPSG:3857 CRS because the server truncates
EPSG:4326 output to 4 decimal places (~11m error). Run with: uv run download_data.py
"""
import json
import math
import sys
import time
import urllib.request
from pathlib import Path

BASE = "https://www.govmap.gov.il/api/geoserver/ows/public/"
DATA = Path(__file__).parent / "data"
RAW = DATA / "raw"
TILES = DATA / "tiles"
TMP = DATA / "_tmp_tiles"
TILE_SIZE = 2000  # meters, EPSG:3857

# The proxy 400s paged requests without sortBy, and responses are cut off at
# ~29s (AWS API Gateway limit) - hence per-layer page sizes tuned to stay under it.
LAYERS = {
    "parcels": {
        "typeName": "govmap:layer_parcel_all",
        "sortBy": "gush_num,parcel",
        "page": 10000,
        "props": ["gush_num", "gush_suffix", "parcel", "legal_area", "status_text"],
    },
    "gushim": {
        "typeName": "govmap:layer_sub_gush_all",
        "sortBy": "gush_num",
        "page": 2000,
        "props": ["gush_num", "gush_suffix", "status_text"],
    },
}


def fetch_page(cfg: dict, start: int) -> dict:
    """Fetch one WFS page with retries; raises after 5 failed attempts."""
    # NOTE: the query string is built without percent-encoding because the
    # gov.il WAF sometimes rejects encoded ':' and '/' in query values.
    url = (f"{BASE}?service=WFS&version=2.0.0&request=GetFeature"
           f"&typeNames={cfg['typeName']}&outputFormat=application/json"
           f"&sortBy={cfg['sortBy']}&count={cfg['page']}&startIndex={start}")
    for attempt in range(5):
        try:
            with urllib.request.urlopen(url, timeout=300) as r:
                data = json.load(r)
            if "features" not in data:
                raise ValueError(f"no features key: {str(data)[:200]}")
            return data
        except Exception as e:
            wait = 10 * (attempt + 1)
            print(f"  attempt {attempt + 1} failed ({e}), retrying in {wait}s", flush=True)
            time.sleep(wait)
    raise RuntimeError(f"giving up on {type_name} startIndex={start}")


def download(name: str, cfg: dict) -> None:
    """Page through a WFS layer, saving each page to raw/. Resumable: skips valid existing pages."""
    start, total = 0, None
    while total is None or start < total:
        path = RAW / f"{name}_{start:07d}.json"
        if path.exists():
            try:
                page = json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                print(f"  {path.name} corrupt, refetching", flush=True)
                page = None
        else:
            page = None
        if page is None:
            page = fetch_page(cfg, start)
            path.write_text(json.dumps(page, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        if total is None:
            total = page["numberMatched"]
            print(f"{name}: {total} features total", flush=True)
        got = len(page["features"])
        print(f"{name}: {start + got}/{total}", flush=True)
        if got == 0:
            break
        start += got


def geom_bbox(geom: dict) -> tuple:
    """Bounding box of a (Multi)Polygon geometry."""
    xs, ys = [], []
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    for poly in polys:
        for ring in poly:
            for x, y in ring:
                xs.append(x)
                ys.append(y)
    return min(xs), min(ys), max(xs), max(ys)


def build_tiles() -> None:
    """Assign each feature to every 2km tile its bbox touches (NDJSON temp files),
    then pack each tile into a single JSON the app can fetch."""
    if TMP.exists():
        for f in TMP.iterdir():
            f.unlink()
    TMP.mkdir(parents=True, exist_ok=True)
    seen = set()
    counts = {}
    for name, cfg in LAYERS.items():
        kind = name[0]  # 'p' / 'g'
        for path in sorted(RAW.glob(f"{name}_*.json")):
            page = json.loads(path.read_text(encoding="utf-8"))
            buckets = {}
            for feat in page["features"]:
                if feat["id"] in seen:  # WFS paging can rarely duplicate rows
                    continue
                seen.add(feat["id"])
                counts[name] = counts.get(name, 0) + 1
                props = feat["properties"]
                rec = {"k": kind, "geom": feat["geometry"]}
                rec.update({p: props.get(p) for p in cfg["props"]})
                line = json.dumps(rec, ensure_ascii=False, separators=(",", ":"))
                x0, y0, x1, y1 = geom_bbox(feat["geometry"])
                for ix in range(math.floor(x0 / TILE_SIZE), math.floor(x1 / TILE_SIZE) + 1):
                    for iy in range(math.floor(y0 / TILE_SIZE), math.floor(y1 / TILE_SIZE) + 1):
                        buckets.setdefault((ix, iy), []).append(line)
            for (ix, iy), lines in buckets.items():
                with open(TMP / f"{ix}_{iy}.ndjson", "a", encoding="utf-8") as f:
                    f.write("\n".join(lines) + "\n")
            print(f"tiling {path.name}: {counts.get(name, 0)} features done", flush=True)

    TILES.mkdir(parents=True, exist_ok=True)
    tmp_files = list(TMP.iterdir())
    for i, tf in enumerate(tmp_files):
        parcels, gushim = [], []
        with open(tf, encoding="utf-8") as f:
            for line in f:
                rec = json.loads(line)
                (parcels if rec.pop("k") == "p" else gushim).append(rec)
        out = TILES / (tf.stem + ".json")
        out.write_text(json.dumps({"parcels": parcels, "gushim": gushim},
                                  ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        tf.unlink()
        if (i + 1) % 1000 == 0:
            print(f"packed {i + 1}/{len(tmp_files)} tiles", flush=True)
    TMP.rmdir()
    (TILES / "meta.json").write_text(json.dumps({
        "tileSize": TILE_SIZE, "crs": "EPSG:3857", "counts": counts,
        "generated": time.strftime("%Y-%m-%d"),
    }), encoding="utf-8")
    print(f"done: {len(tmp_files)} tiles, counts={counts}", flush=True)


if __name__ == "__main__":
    RAW.mkdir(parents=True, exist_ok=True)
    if "--tiles-only" not in sys.argv:
        for name, cfg in LAYERS.items():
            download(name, cfg)
    build_tiles()
