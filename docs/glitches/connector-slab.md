# Connector slab: a sloped bridge sidewalk lying across the Connector's west lanes

Investigation only. Nothing in the pipeline or game was changed.

## Where

- Tile `atlanta/m1-five-points`, game metres (x east, z south).
- The slab: x 621.8 to 637.0, z 497.2 to 502.3, y -8.9 (top, at the deck) down to -15.6 (at lane height).
- The overpass it hangs off: Decatur Street SE bridge, deck from (638.5, -8.7, 493.2) to (754.9, -8.7, 498.8).
- The lanes under it: Downtown Connector carriageway `osm:way/316454382` (w 28.9 m, y about -16 here), and motorway_link `osm:way/9236952` (x 643 at z 500).
- Node in `roads.glb`: `sidewalk_6_5` (chunk cx 6, cz 5; 22 sloped triangles in the area, 11 of them on this piece).

The brief put Memorial Dr SE at x 650 to 750, z 450 to 550. In this tile it is not there. Memorial Drive Southeast and Southwest run at z about 812 to 826. The Decatur bridge and the Connector are what cross at x 640 to 755, z 490 to 500. The "Memorial Dr SE" label in the screenshot is not explained by the road data. The location above comes from the geometry and the overpass in the screenshot (the Decatur deck crosses the view ahead, with the slab on its west end, which is the right-hand side when facing south). I did not confirm the exact camera pose in-game.

## Mesh and material

- `road_sidewalk` (node `sidewalk_6_5`), 4 to 4.5 m wide, a strip running from the bridge's west end down onto the Connector.
- Triangle normals have |ny| 0.76 to 0.95, so the facets are tilted 18 to 41 degrees. The strip as a whole drops 6.4 m over 15 m horizontal, about 23 degrees.
- Vertices along the strip (x, y, z): (621.8, -8.9, 498.7), (625.7, -9.4, 498.3), (629.3, -11.0, 499.0), (632.9, -13.5, 499.8), (636.6, -15.4, 500.5).

## Cause

- OSM way `osm:way/38945249`, "Decatur Street Southeast": `bridge=yes`, `layer=1`, `highway=secondary`, `sidewalk:both=separate`, `cycleway:both=lane`. The bridge ends at x 638.5.
- The pipeline makes the sidewalks for a bridge with `sidewalk:both=separate`, and it extends them past the deck end to the ground. Here that extension is 17 m long and falls 6.4 m. It does not stop at the abutment. It runs over the Connector's west lanes and ends at lane height, where the sidewalk slab is above the carriageway.
- The sidewalk slab is not solid. In `src/world/roads.ts`, a `ped` slab is left out of the collision mesh where it sits low over a car road (`lowOver`, around line 1036). The `ped` slab's footprint over car decks also ends up out of collision (line 1032). So the slab is drawn but cars drive through it.
- Not checked: the exact code path that builds this sidewalk extension, and whether the 17 m drop past the abutment is intended.

## Solidity

- Checked `public/tiles/atlanta/m1-five-points/collision.bin`: no triangles at all in x 610 to 650, z 490 to 508 with a slope below y -10. The only collision there is the bridge deck itself (x 637 to 652, y -9.7 to -7.8) and its walls.
- So the slab is visual only. A car passes through it at lane height.

## Other notes

- The sloped sidewalk at x 756 to 767, z 489 to 492, descending from -8.8 to -12.5, is the east end of the same bridge sidewalk. I did not check whether it also lies on lanes.
- The "oddly angled pier" in the screenshot was not identified in the data.

## Suggested fix for the pipeline owner

- In the sidewalk-past-bridge extension (`src/world/roads.ts`, the `sidewalks and paths that run beside a bridge` path around line 655), stop the extension at the deck end, or at the abutment, rather than sloping it onto the lanes below. A ped slab that drops onto a car road below it should be cut off where its height is within about 1 m of the road it crosses.
- Failing that, drop any `ped` triangles that lie over a car-road footprint below them from the drawn mesh too, so the mesh matches the non-solid collision.
- Check this on other bridges with `sidewalk:both=separate` that cross the Connector.
