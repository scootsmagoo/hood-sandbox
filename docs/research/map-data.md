# Map data research: sources, licenses, scale, pipeline

*Research pass, 14 October 2026. Figures marked "estimate" were not checked against a primary source.*

## 1. Area and scale

| Area | Land area | Source |
|---|---|---|
| City of Atlanta | ~135 mi² / 350 km² | Wikipedia (2020 Census) |
| Cobb County | 339.78 mi² / 880 km² | Census QuickFacts 2020 |
| Gwinnett County | 430.76 mi² / 1,116 km² | Census QuickFacts 2020 |
| North Fulton (Sandy Springs, Roswell, Alpharetta, Johns Creek, Milton) | ~450 km² | estimate |
| North DeKalb (Brookhaven, Dunwoody, Chamblee, Doraville, Tucker) | ~125 km² | estimate |
| **Total** | **~2,900 km²** | |

- **Bounding box:** about 33.64–34.13°N by 84.74–83.80°W, roughly 55 × 87 km, or **about 4,800 km²**.
- **Inside the box:** Kennesaw Mountain and Stone Mountain. The Chattahoochee forms the Cobb–Fulton line.
- **At the edges:** Lake Lanier only touches Gwinnett's northeast tip at Buford. Lake Allatoona is just north of Cobb.

### Game maps for comparison

These are mostly fan estimates, and they vary.

| Game | Map size | Note |
|---|---|---|
| GTA V | ~75–80 km² | Quoted figures range from 48 to 126 km² |
| GTA VI (Leonida) | "about twice GTA V" | Rockstar's own claim |
| Forza Horizon 5 | ~107 km² | |
| Watch Dogs 2 | ~22 km² | About half is water |
| The Crew | ~5,000 km² | Developer figure; roughly 1:40 linear compression of the contiguous US |

GTA V's Los Angeles is compressed roughly 1:5–1:7 in linear terms (estimate). It keeps the main roads and landmarks roughly in place and drops most streets.

### At 1:1 scale

- Crossing 87 km at 100 km/h takes about 52 minutes.
- There would be about 2 million building footprints and about 50,000 km of road (estimates).

### Options

- **A. 1:1, with travel helpers.** Faithful, but huge to bake and mostly empty subdivisions.
- **B. Faithful layout, compressed about 1:4–1:8 linear.**
  - Distances shrink, while people, cars and buildings stay 1:1.
  - The road network has to be rebuilt for the new size, not just scaled.
  - Skyrome's atlas works this way (`WORLD_SCALE = 0.6` with humans at 1:1).
- **C. Variable compression.** The intown core at about 1:1.5–1:2, suburbs at about 1:8, with compressed interstates between them.
- **Recommended: C, or B with variable density.** Generate everything from real data, then warp it with control points.

**Owner's decision (14 Oct):** a compressed layout. See the README for the variable factors chosen.

## 2. Roads

### OpenStreetMap (ODbL)

- OSM has the tags we need: `lanes`, `maxspeed`, `oneway`, `turn:lanes`, `layer`, `bridge`, `tunnel` and `junction`.
- Motorway link ramps are mapped in detail.
- There is no real 3D geometry, so ramps need `layer` ordering plus our own elevation profiles.

### What ODbL means for this game

- The OSMF Produced Work guideline turns on whether the published work is "intended for the extraction of the underlying data". Rendered maps and images are usually Produced Works, which need attribution only. Games and 3D models aren't addressed.
- Road graphs and building footprints shipped to the browser as JSON or binary can be extracted, so the shipped assets could be argued to be a Derivative Database.
- In any case, ODbL 4.6 requires offering the derivative database the game was built from.
- Safest course:
  - Attribute in-game and in the credits.
  - Publish the cleaned and conflated vector database under ODbL.
  - Keep the game's code and art under any license we choose.
- Not legal advice. Get a lawyer's review before a commercial release.

### Overture Maps

- Transportation (OSM plus TomTom), Buildings (OSM, Microsoft, Esri, Google and USGS 3DEP heights), Base and Divisions are **ODbL**.
- Places is mostly **CDLA Permissive 2.0**. The Foursquare part is under Apache 2.0 and needs a NOTICE file.
- Distributed as GeoParquet, which DuckDB can query directly.

### Georgia DOT (GDOT) Road Inventory

- About 125,000 centerline miles, as a 469 MB geodatabase.
- Likely has lane counts and functional class, but the fields and date are unconfirmed.
- Public agency data with no stated license.
- Use it to fill gaps in lanes and speeds, not as the road geometry.

### Other road data

- The USGS National Transportation Dataset for Georgia (Feb 2026) is public domain but less detailed than OSM.
- County road centerlines are on the county GIS portals.

### Interchanges to build by hand

- Spaghetti Junction (I-85 / I-285; 5 levels)
- The Downtown Connector (I-75/85)
- I-285 / GA-400 (recently rebuilt)
- I-20 / the Connector
- The Cobb Cloverleaf (I-75 / I-285)

## 3. Buildings

| Source | Coverage | Heights | Notes |
|---|---|---|---|
| OSM | Good in central Atlanta, patchy in the suburbs | Some | |
| Microsoft footprints (ODbL) | About 9.8M US footprints | Partial in the global set (−1 where missing) | Quality varies |
| **Overture buildings (ODbL)** | Merges OSM, Microsoft and Esri | `height` and `num_floors`, some from 3DEP lidar | **The best ready-made source.** We haven't checked what share of metro Atlanta has a height. |
| Google Open Buildings 2.5D | Africa, Asia, Latin America and the Caribbean | | **No US coverage** |
| Cobb County footprints | County | | Appear to be sold (the county's GIS data sales list) |
| Gwinnett County | Has an ArcGIS open-data hub | | Footprints unconfirmed |
| "Atlanta_Buildings" FeatureServer | City | | Publisher and license unconfirmed |

**Best heights:** compute them ourselves from 3DEP lidar. For each footprint, take the top of the first returns minus the bare-earth ground, using PDAL's height-above-ground filters (`filters.hag_*`) or zonal statistics on DSM minus DTM. The result is public domain.

## 4. Terrain and water

- **USGS 3DEP is public domain:** 1 m bare-earth elevation model, 1/3″ (about 10 m) elevation model, and lidar point clouds.
- **Lidar** is in `s3://usgs-lidar-public` in Entwine (EPT) format, for example `GA_Statewide_B1_2018` and `GA_Central_1_2018`.
  - Central Georgia 2019–20 lists Gwinnett.
  - **Coverage projects for Cobb, Fulton and DeKalb are unconfirmed.** Check the 3DEP Lidar Explorer.
  - NOAA notes EPT issues with GA_Statewide.
- **Fallback elevation:** Copernicus GLO-30 or SRTM, only for far-off-map terrain.
- **Water:** NHD/3DHP (public domain), plus OSM water polygons for the Chattahoochee, Lanier and Allatoona.
- Stone Mountain and Kennesaw Mountain render well from the 1 m model.

## 5. Other layers

- **Land cover:** Annual NLCD Collection 1.1 (30 m, 1985–2024, public domain, Cloud-Optimized GeoTIFFs on AWS), plus OSM `landuse` and `natural` tags.
- **Trees:** the Meta/WRI/Land & Carbon Lab 1 m canopy height map (reportedly CC BY 4.0; verify). Atlanta's tree canopy is heavy, so this matters.
- **Parcels and zoning:**
  - City of Atlanta DPCD (`dpcd-coaplangis.opendata.arcgis.com`, `gis.atlantaga.gov`)
  - Atlanta Regional Commission (`opendata.atlantaregional.com`, a good regional source)
  - Gwinnett ArcGIS Hub
  - Cobb GIS (`gis.cobbcounty.org`; mostly sold)
  - Georgia GIO
- **Transit:** MARTA GTFS (Mobility Database mdb-368), CobbLinc and Ride Gwinnett GTFS.
- **Points of interest:** OSM and Overture Places. Brand names and logos are a trademark issue, not a data-license one, so they get parody names.

## 6. Photorealistic 3D tiles: not usable

- **Google Map Tiles API:**
  - The terms forbid "pre-fetch, index, store, or cache any Content", offline use, and "geodata extraction".
  - Any overlaid 3D objects must not be "extracted, traced, or otherwise derived" from the tiles.
  - Live streaming with attribution is allowed but costs money per use and looks poor up close.
- **Cesium OSM Buildings:** offline use isn't possible on the community plan. Building our own from OSM and Overture gains the same thing.

## 7. Tooling and hard problems

### Data processing

- `osmium`: extracts and filters
- Planetiler: vector tiles
- DuckDB: Overture
- GDAL: rasters and reprojection
- PDAL: lidar, ground models and building heights

### 3D from OSM

- OSM2World (LGPL; exports glTF)
- Blender-OSM and BlenderGIS
- **Streets GL** (MIT, TypeScript and WebGL2): the closest browser reference, though early-stage and last updated around Sept 2024.

### Driving games and simulators

- **TerraDrive** (MIT): OSM to BeamNG, with lanes, divided roads, curbs, bridges and ramps. Handles small areas only.
- MapNG.
- **BeamNG Road Architect:** lane-level roads based on OpenDRIVE (an open format for lane-level road networks). A good model for junctions.
- CARLA's `Osm2Odr`: flattens elevation.
- **OpenTwinMap** (arXiv 2511.21925): US OSM data to OpenDRIVE.

### Hard problems

- **Interchanges:** turn `layer` and bridge tags into real decks with about 5 m clearance, and give ramps smooth, grade-limited profiles. Big stacks need hand overrides.
- **Intersections:** group nodes into junctions, build junction polygons from lane widths, and add crosswalks, turn lanes and signals.
- **Road profiles:** sample the elevation model along each road, smooth it (limit grade and curvature), and cut and fill the terrain to the road. On bridges, follow the deck line instead of the ground.
- **Scale:** tiles of about 256–512 m, with LOD meshes merged per material, glTF + meshopt + KTX2, and streaming by distance.

## Recommended pipeline

1. **Area and projection.** Use a custom transverse Mercator projection, `+proj=tmerc +lat_0=33.85 +lon_0=-84.3` (in meters). Gwinnett crosses the line between UTM zones 16 and 17.
2. **Ingest:**
   - Geofabrik Georgia extract, cut with `osmium extract`
   - Overture transportation, buildings and places (via DuckDB)
   - 3DEP 1 m elevation model and lidar (EPT)
   - NLCD land cover
   - canopy height
   - NHD water
   - GTFS transit feeds
3. **Conflate.** OSM road geometry with GDOT filling gaps, and Overture footprints with 3DEP heights where missing. Keep it all in one versioned PostGIS or GeoParquet store; this is the ODbL Derivative Database we publish.
4. **Compress.** Apply the control-point warp, then thin the street hierarchy by class.
5. **Generate:**
   - roads → junctions → lane meshes, with smoothed profiles and bridge decks
   - terrain conformed to the roads
   - extruded buildings with roof and facade styles, plus hand-built landmarks
   - trees from canopy and NLCD
6. **Bake.** glTF + meshopt + KTX2 tiles with LODs and collision boxes.
7. **Attribute.** Credit OSM, Overture, Microsoft, Esri and USGS, and publish the conflated database.

## Open data questions

- 3DEP coverage and dates for Cobb, Fulton and DeKalb
- GDOT inventory fields and date
- Share of buildings with Overture heights
- Licenses for the canopy map and Blender-OSM
- Whether Atlanta's and Gwinnett's building footprints are free to use

## Sources

- https://www.census.gov/quickfacts/fact/table/cobbcountygeorgia/POP010220
- https://www.census.gov/quickfacts/fact/table/gwinnettcountygeorgia
- https://en.wikipedia.org/wiki/Atlanta
- https://www.gtabase.com/articles/gta-6/how-big-is-the-gta-6-map-size-compared-to-other-games
- https://wiki.gtaboom.com/wiki/How_Well_Does_GTA_V%27s_Map_Emulate_Los_Angeles
- https://turboduck.net/news/driving-games/the-crew-sense-of-scale/
- https://osmfoundation.org/wiki/Licence/Community_Guidelines/Produced_Work_-_Guideline
- https://osmfoundation.org/wiki/Licence_and_Legal_FAQ
- https://docs.overturemaps.org/attribution/
- https://docs.overturemaps.org/guides/buildings
- https://github.com/microsoft/globalmlbuildingfootprints
- https://www.dot.ga.gov/GDOT/Pages/RoadTrafficData.aspx
- https://www.sciencebase.gov/catalog/item/5a5f36bee4b06e28e9bfc1ba
- https://gis.cobbcounty.org/Geocortex/Essentials/REST/virtualdirectory/GIS_DataSales_Specifications.pdf
- https://friendlycities.gatech.edu/wp-content/uploads/2023/02/Atlanta-Open-Data-Resources.pdf
- https://www.fisheries.noaa.gov/inport/item/70012
- https://www.fisheries.noaa.gov/inport/item/67264
- https://github.com/hobuinc/usgs-lidar
- https://developers.google.com/earth-engine/datasets/catalog/USGS_3DEP_1m
- https://www.usgs.gov/centers/eros/science/usgs-eros-archive-land-cover-annual-nlcd-collection-1-land-cover-change
- https://landcarbonlab.org/data/global-tree-canopy-height
- https://mobilitydatabase.org/feeds/gtfs/mdb-368
- https://developers.google.com/maps/documentation/tile/policies
- https://community.cesium.com/t/offline-buildings-tiles/11769
- https://github.com/strandedkitty/streets-gl
- https://osm2world.org/
- https://carla.readthedocs.io/en/0.9.12/tuto_G_openstreetmap/
- https://arxiv.org/pdf/2511.21925
- https://boxthislap.org/beamng-drive-real-world-map-generator-terradrive/
- https://documentation.beamng.com/world_editor/tools/road_architect/introduction
