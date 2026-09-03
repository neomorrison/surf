/* ============================== [PACKED MAPS] ==============================
   The community maps this site ships, and who made them.

   Each is a real Source surf map, packed by tools/pack-map.mjs into the part
   of itself the game reads — see src/maps/smap.js for why that is a twelfth
   of the file. They are downloaded when chosen, not on load, so opening the
   page still costs nothing.

   These maps are other people's work. They are here because they are the
   maps this movement code exists to ride, and they are credited by name in
   the README. If you made one of these and would rather it were not here,
   open an issue and it comes out.

   `bytes` is what the file weighs, so the picker can say what it is about to
   fetch before it fetches it. Keep it in step with maps/ — npm run pack
   prints the numbers.                                                       */
import { packedCourse } from './packedcourse.js';
import { prettyMapName, uniqueMapName } from '../mapname.js';

const map = (id, file, bytes, blurb, name) => packedCourse({
  id, bytes, blurb,
  name: name || prettyMapName(file),
  url: `maps/${file}.smap`,
  stageName: 'RUN',
  hint: 'Start to finish.',
});

export const maps = [
  /* The map the built-in course is named for: SnoopSh's, 2012, tier 1. Both
     are in the picker, so the real one keeps the tag that tells them apart. */
  map('aircontrol_ksf', 'surf_aircontrol_ksf', 2544366,
    'The map the built-in course is named after. Six ramps, one shot.',
    uniqueMapName('surf_aircontrol_ksf', ['Surf AirCtrl'])),
  map('utopia_njv', 'surf_utopia_njv', 4249917,
    'Long linear descent. No timer zones in the file, so this one runs untimed.'),
  map('cyberwave', 'surf_cyberwave', 6722921,
    'Neon canyon. Tight, fast, and lit like it means it.'),
  map('mesa_fixed', 'surf_mesa_fixed', 10605464,
    'Displacement terrain — you ride the ground itself. Untimed: the file has no zones.'),
  map('mesa_mine', 'surf_mesa_mine', 7512746,
    'The mine below the mesa. Displacement terrain, thirty-three teleports.'),
  /* The only one so far whose author named its timer zones the way a timer
     server expects, so it is the only one that arrives already timed. */
  map('boreas', 'surf_boreas', 4265883,
    'Snow and ice, ridden on displacement terrain. Its own start and finish zones, so it runs timed.'),
  map('summer', 'surf_summer', 21185343,
    'The big one. Five hundred meshes, a quarter million terrain triangles.'),
];
