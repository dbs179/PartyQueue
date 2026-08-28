// Seasonal holiday (mostly Christmas) filter for auto-picks.
//
// Genre is artist-level, so Kelly Clarkson lands in Pop even when the track is
// "Underneath the Tree". Random / Discover / Moods should not play that in
// August. During the holiday window, these tracks are allowed like anything else.

/** Inclusive: Nov 15 through Jan 2. */
export function isHolidaySeason(date = new Date()) {
  const month = date.getMonth() + 1;
  const day = date.getDate();
  if (month === 12) return true;
  if (month === 1 && day <= 2) return true;
  if (month === 11 && day >= 15) return true;
  return false;
}

const HOLIDAY_PHRASE =
  /\b(?:christmas|x-?mas|navidad|yuletide|hanukkah|hannukah|chanukah|kwanzaa|kwanza|dreidel|mistletoe|nutcracker|grinch)\b/i;

const HOLIDAY_TITLE_PHRASE =
  /\b(?:jingle bell|sleigh ride|winter wonderland|let it snow|frosty the snow|little drummer boy|silent night|o holy night|deck the hall|carol of the bells|fairytale of new york|wizards in winter|baby it'?s cold outside|most wonderful time|chestnuts roasting|have yourself a merry|underneath the tree|santa tell me|santa baby|santa claus|here comes santa|run rudolph|up on the house|must be santa|grandma got run over|white christmas|blue christmas|feliz navidad|the first noel|little saint nick|auld lang syne)\b/i;

const HOLIDAY_ALBUM_PHRASE =
  /\b(?:holiday (?:hits|songs|classics|collection|album)|wrapped in red|christmas)\b/i;

function fieldsOf(track = {}) {
  const name = String(track.name || track.title || "");
  const album = String(track.album || "");
  return { name, album, haystack: `${name} ${album}`.trim() };
}

/** True when title/album looks like a Christmas (or similar seasonal) song. */
export function isHolidayTrack(track = {}) {
  const { name, album, haystack } = fieldsOf(track);
  if (!haystack) return false;
  if (HOLIDAY_PHRASE.test(haystack)) return true;
  if (HOLIDAY_TITLE_PHRASE.test(name)) return true;
  if (album && HOLIDAY_ALBUM_PHRASE.test(album)) return true;
  return false;
}

/**
 * Auto-picks should skip this track outside the holiday window.
 * Cheap enough to call once per playlist-pool candidate.
 */
export function isOutOfSeasonHolidayTrack(track = {}, date = new Date()) {
  if (isHolidaySeason(date)) return false;
  return isHolidayTrack(track);
}
