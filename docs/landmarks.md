# Landmarks (city pack)

`data/cities/atlanta/landmarks.json` lists the hero and notable landmarks of the Atlanta pack, with real positions. `data/cities/atlanta/brands.json` maps every real brand or corporate mark used there to a parody name.

## Schema

Top level: `city`, `tile`, `origin` (the Five Points tile origin, 33.7543 N, 84.3898 W), `projection` (the same `+proj=tmerc +lat_0=33.85 +lon_0=-84.3` as `city.json`), and `landmarks`.

Each landmark:

| Field | Meaning |
|---|---|
| `id` | Unique slug. |
| `name` | The real name. |
| `displayName` | The name shown in game: the parody for trademarked entries, otherwise the real name. |
| `trademark` | `true` when the name is a brand, corporate mark or protected word (including "Olympic"). |
| `formerName` | Optional earlier name (e.g. CNN Center, now The Center). |
| `kind` | `stadium`, `arena`, `museum`, `tower`, `civic`, `church`, `park`, `tunnel`, `shopping`, `transit`, `monument`, `interchange`, `trail`, `neighborhood-landmark`, and so on. |
| `district` | District name, as in the README's district list. |
| `lat`, `lon` | WGS84 position (OSM centroid where verified). |
| `x`, `z` | Game metres from the projection: x east, z south, origin at Five Points, rounded to 0.1 m. |
| `inM1Tile` | `true` when `|x|` and `|z|` are both at most 1000 (the M1 tile). |
| `osm` | OSM element ids (`way/…`, `relation/…`, `node/…`) used for the position. |
| `priority` | `hero` (needs a hand-built model) or `notable` (data-driven is fine). |
| `sensitive` | `true` for sites the README asks to treat with respect. Their `look` is neutral. |
| `unverified` | `true` when the position is from memory and not checked against OSM. |
| `look` | 1 to 3 sentences for the modeller. Brand names are kept out of it. |
| `opened` | Year opened, or `null` when not confirmed. |
| `sources` | Wikipedia and OSM links. |
| `anchors` | Trails only: an array of anchor points, each with its own `lat`, `lon`, `x`, `z`, `inM1Tile`. |

## Brands

`brands.json` has `{ "brands": [ { real, parody, kind, note } ] }`. A parody must echo the original without reusing the mark. The owner reviews the parody names. The Atlanta BeltLine is a registered mark of Atlanta BeltLine, Inc., so it is parodied too.

## Validation

Every `id` is unique, the required fields are present, `inM1Tile` agrees with `x` and `z`, and every `lat`/`lon` lies inside the README metro box (33.62 to 34.22 N, 84.78 to 83.82 W).
