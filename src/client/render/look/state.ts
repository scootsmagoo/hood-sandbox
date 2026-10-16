/** What the look has switched on, for the one place outside look/ that needs to know (Atmosphere's old flat night glow). */
export const lookState = {
  /** The procedural facade is drawing the walls, with its own lit windows. */
  facade: false,
  /**
   * 0 to 1: how far the camera is in the spaces under the ground (a station, a tunnel; render/transit/TransitView.ts sets it):
   * Atmosphere takes the sun and the sky's light away and closes the fog in as it rises.
   */
  interior: 0,
};
