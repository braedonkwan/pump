import { MAX_PUMPS } from '../engine/PumpEngine.js';

export const FLIGHT_ZONES = [
  {
    id: 'meadow',
    shortName: 'Meadow',
    color: '#90cde6',
    pump: 0,
    name: 'The meadow',
    caption: 'The meadow is just the beginning.',
  },
  {
    id: 'cloudlands',
    shortName: 'Cloudlands',
    color: '#80b4ef',
    pump: 4,
    name: 'Cloudlands',
    caption: 'A little closer to the extraordinary.',
  },
  {
    id: 'crystal-expanse',
    shortName: 'Crystal',
    color: '#39b5d7',
    pump: 8,
    name: 'Crystal expanse',
    caption: 'A thousand colors caught in the light.',
  },
  {
    id: 'tempest-sea',
    shortName: 'Tempest',
    color: '#3a438e',
    pump: 12,
    name: 'The tempest sea',
    caption: 'An ocean of clouds. A river of light.',
  },
  {
    id: 'aurora-gardens',
    shortName: 'Aurora',
    color: '#65458f',
    pump: 16,
    name: 'Aurora gardens',
    caption: 'Where even the night is in bloom.',
  },
  {
    id: 'celestial-ruins',
    shortName: 'Ruins',
    color: '#343267',
    pump: 20,
    name: 'Celestial ruins',
    caption: 'Some wonders have waited forever to be found.',
  },
  {
    id: 'stargate',
    shortName: 'Stargate',
    color: '#38306f',
    pump: 23,
    name: 'The stargate',
    caption: 'One last horizon. Something extraordinary beyond it.',
  },
  {
    id: 'astral-crown',
    shortName: 'Crown',
    color: '#6b4386',
    pump: 25,
    name: 'The Astral Crown',
    caption: 'The very top. A view like no other.',
  },
] as const;

export const BACKDROP_OVERLAP = 0.24;
const BACKDROP_SPAN =
  FLIGHT_ZONES.length - (FLIGHT_ZONES.length - 1) * BACKDROP_OVERLAP;

export function getBackdropSegments(worldHeight: number) {
  if (!Number.isFinite(worldHeight) || worldHeight <= 0) {
    throw new RangeError('Backdrop height must be positive and finite.');
  }
  const height = worldHeight / BACKDROP_SPAN;
  return FLIGHT_ZONES.map((zone, index) => ({
    id: zone.id,
    src: `/art/world/${zone.id}.png`,
    mobileSrc:
      zone.id === 'astral-crown'
        ? '/art/world/astral-crown-mobile.png'
        : undefined,
    color: zone.color,
    bottom: index * height * (1 - BACKDROP_OVERLAP),
    height,
  }));
}

function validatePumps(pumps: number): void {
  if (!Number.isInteger(pumps) || pumps < 0 || pumps > MAX_PUMPS) {
    throw new RangeError('Flight pump count must be between 0 and 25.');
  }
}

export function getFlightZone(pumps: number) {
  validatePumps(pumps);
  for (let index = FLIGHT_ZONES.length - 1; index >= 0; index--) {
    const zone = FLIGHT_ZONES[index];
    if (zone && pumps >= zone.pump) return { ...zone, index };
  }
  throw new Error('Flight zone is missing.');
}

export function getWorldAtmosphere(pumps: number) {
  validatePumps(pumps);
  return {
    wonder: 0.2 + 0.8 * (pumps / MAX_PUMPS) ** 1.5,
    crownGlow: Math.max(0, (pumps - 21) / (MAX_PUMPS - 21)),
  };
}

export function getWorldLayout(width: number, height: number, pumps: number) {
  validatePumps(pumps);
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new RangeError(
      'World viewport dimensions must be positive and finite.',
    );
  }
  // Each scene has room to unfold; mobile crops the sides instead of stretching it.
  const worldHeight = Math.max(
    (width * BACKDROP_SPAN) / 1.5,
    height * (FLIGHT_ZONES.length - 1),
  );
  const maxOffset = worldHeight - height;
  const progress = pumps / MAX_PUMPS;
  return { worldHeight, maxOffset, offset: maxOffset * progress, progress };
}
