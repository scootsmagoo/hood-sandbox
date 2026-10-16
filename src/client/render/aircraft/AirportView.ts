/**
 * The client side of a city's airport (`aeroway.json`, named by the city's index): the aircraft, the airfield and aircraft lights,
 * and the airport on the radar and the map. `loadAirport` reads the file and adds the systems; a city without an airport, or a
 * file that fails to load, adds nothing.
 */
import { parseAeroway, type AerowayData } from '../../../shared/aeroway';
import type { Game } from '../../Game';
import { AirportLayer } from '../../ui/airportMap';
import { AircraftViews } from './AircraftViews';
import { AirfieldLights } from './AirfieldLights';

export interface Airport {
  data: AerowayData;
  aircraft: AircraftViews | null;
  lights: AirfieldLights;
  layer: AirportLayer;
  dispose(): void;
}

export async function loadAirport(game: Game, cityBase: string, rel: string): Promise<Airport | null> {
  try {
    const res = await fetch(new URL(rel, cityBase).href);
    if (!res.ok) return null;
    const data = parseAeroway(await res.json());
    const aircraft = game.params.get('aircraft') === '0' ? null : game.addSystem(new AircraftViews(game, data));
    const lights = game.addSystem(new AirfieldLights(game, data, aircraft));
    const layer = new AirportLayer(game, data);
    return {
      data,
      aircraft,
      lights,
      layer,
      dispose() {
        aircraft?.dispose();
        lights.dispose();
        layer.dispose();
      },
    };
  } catch (e) {
    console.warn(`airport: ${(e as Error).message}`);
    return null;
  }
}
