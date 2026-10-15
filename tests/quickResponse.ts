import { POLICE_RULES } from '../src/shared/policeRules';

/**
 * The first police response as it was before the pacing pass: no radio delay, cars from the old 120 to 200 m
 * ring, helicopters at once. For the tests about what the police do once they are there (roles, roadblocks,
 * the helicopter's sight), which would otherwise spend half a minute waiting for the first car. The tests about
 * the pacing itself (`pacing.test.ts`) do not call this. Each test file has its own copy of the rules, so call
 * it once at the top of the file.
 */
export function quickResponse(): void {
  const zeros = POLICE_RULES.dispatch.delayS.map((): [number, number] => [0, 0]);
  Object.assign(POLICE_RULES.dispatch, {
    spawnMinM: POLICE_RULES.dispatch.spawnMinM.map((_, i) => (i === 0 ? 0 : 120)),
    spawnMaxM: POLICE_RULES.dispatch.spawnMaxM.map((_, i) => (i === 0 ? 0 : 200)),
    delayS: zeros,
  });
  POLICE_RULES.helicopter.delayS = [0, 0];
}
