import { beforeAll } from 'vitest';
import { palette } from '../../runner/src/graphs/palette';
import { __setCachedPaletteForTest } from '../lib/palette';

beforeAll(() => {
    __setCachedPaletteForTest(palette);
});
