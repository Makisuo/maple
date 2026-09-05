# Voxel service map

The existing orthographic factory diorama is built from visible blocks. Keep Maple's
Geist labels, warm app chrome, health colors, service badges, Atlas/Cascade layouts,
and graph interactions. The shared 3D scene serves both the lab and the live service map.

Machine shells use approximately 0.1-unit voxels with flat faces and subtle seeded
tonal variation. Cylinders become stepped volumes, pipe cross-sections and collars
become square, and moving requests are cubes. Terrain uses a coarser grid, with
grass-topped dirt columns and block-built tree canopies.

Use ochre processors, mineral-green storage, warm steel, rich meadow-green
terrain, and golden/apricot/russet trees from the approved sunset reference. Health belongs to the small status lamps and
HTML labels. Selection retains its amber base and adds a square ground marker.

Geometry must preserve machine footprints and connection anchors. Merge visible
voxel faces into one geometry per machine part and instance landscape blocks.
Keep the existing motion pause and reduced-motion handling. HTML controls and
service labels remain the accessible way to inspect every node.

Lighting follows the supplied floating-island sunset video: peach and lilac sky,
a pale sun behind the island, warm golden key light, lavender fill, and soft,
lower-contrast shadows. The sunset scene palette remains consistent across app
themes; product controls and labels retain their theme-aware contrast. Use a
stable 4096-pixel soft shadow map, refreshed when geometry changes. Keep matte
paint and fine voxel tinting. Separate adjoining surfaces to avoid flickering.

The island has an irregular stepped shoreline within its conservative camera
bounds. Sandy upper cliffs transition into mauve rock underneath, forming a
tapered, closed voxel shell instead of a flat slab. Keep the small blocks, full
service-platform support, and lush grass. The terrain has no unrelated buildings
or implied service nodes.

Use finer voxels throughout: approximately 0.4-unit ground cubes and elevation
steps, 0.2-unit foliage and trunk voxels, 0.1-unit machine shells, and 0.03–0.09-unit
mechanical details. Terrain elevation is sampled and quantized directly on the
fine grid, producing more intermediate steps across the hills. There is no
coarse elevation grid hidden behind subdivided blocks. Buildings and trees keep
their overall size while their silhouettes and surfaces gain smaller voxel detail.
Grass caps dirt columns; omit buried dirt cubes. Keep service aprons and routes
clear and seat vegetation on the actual block heights.

The meadow is part of the finished scene: dense clusters of fine, stepped grass
blades with varied height and green tones, plus scattered cream and yellow flowers.
Seat each blade on its own terrain tile so tufts remain grounded at ledges. Keep
tufts away from machine aprons and transport routes. Memoize the landscape against
structural routes; metric refreshes must not regenerate or upload its instances.

The sun is a simple pale, flat disc with broad atmospheric warmth, matching the
reference's stylized sunset. It stays behind the island without spherical shading.
Cloud banks remain solid stepped voxel volumes at different depths, with warm
tops and lilac undersides; they provide orbit parallax. Background scenery is
non-interactive, has no shadows on the graph, and adds one instanced draw call.

Autumn finishing: rich green ground, spatial patches of deep fern and lush meadow-green grass, fresh green
tips and varied tuft orientations. Tree crowns deepen to russet underneath and
catch honey tones above. Sparse seed heads, cream/gold late-season flowers, and
small fallen voxel leaves under the trees complete the meadow. Keep it lush,
keep all plants seated on the actual stepped terrain, and leave routes clear.

Grass stays rich green, with deep bases and restrained fresh-green tips. Reserve
gold for seed heads, flowers, tree crowns, and fallen leaves rather than turf blades.

Grass-covered ground blocks and terrace tops share the richer green palette of
the meadow tufts. Autumn warmth remains in the foliage and sunset lighting.
