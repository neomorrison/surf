/* Resolve bare "three" to the local stub so map/world can be tested headlessly. */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
register('./loader.mjs', pathToFileURL('./test/'));
