/** DJ Voice form row visibility (TTS provider + shout mode). */

/**
 * @param {string|null|undefined} provider
 * @returns {{ openaiHidden: boolean, elevenlabsHidden: boolean }}
 */
export function djTtsProviderRowVisibility(provider) {
  const eleven = String(provider || "elevenlabs_ha") === "elevenlabs_ha";
  return {
    openaiHidden: eleven,
    elevenlabsHidden: !eleven,
  };
}

/**
 * @param {string|null|undefined} mode
 * @returns {{ percentHidden: boolean, everyHidden: boolean }}
 */
export function djShoutModeRowVisibility(mode) {
  const every = String(mode || "every") === "every";
  return {
    percentHidden: every,
    everyHidden: !every,
  };
}

/**
 * @param {{
 *   openaiRow?: HTMLElement|null,
 *   elevenlabsRow?: HTMLElement|null,
 * }} els
 * @param {string|null|undefined} provider
 */
export function paintDjTtsProviderRows(els, provider) {
  const { openaiHidden, elevenlabsHidden } = djTtsProviderRowVisibility(provider);
  if (els?.openaiRow) els.openaiRow.hidden = openaiHidden;
  if (els?.elevenlabsRow) els.elevenlabsRow.hidden = elevenlabsHidden;
}

/**
 * @param {{
 *   percentRow?: HTMLElement|null,
 *   everyRow?: HTMLElement|null,
 * }} els
 * @param {string|null|undefined} mode
 */
export function paintDjShoutModeRows(els, mode) {
  const { percentHidden, everyHidden } = djShoutModeRowVisibility(mode);
  if (els?.percentRow) els.percentRow.hidden = percentHidden;
  if (els?.everyRow) els.everyRow.hidden = everyHidden;
}
