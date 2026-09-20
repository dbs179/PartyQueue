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

// `christmas` is a prefix match so "Christmastime" counts. Trailing `\b` on
// title phrases is applied per alternative after optional suffixes ("jingle
// bells", "Frosty the Snowman") so "jingle bell" still matches "Jingle Bells".
const HOLIDAY_PHRASE =
  /christmas|x-?mas|navidad|yuletide|hanukkah|hannukah|chanukah|kwanzaa|kwanza|dreidel|mistletoe|nutcracker|\bgrinch\b/i;

const HOLIDAY_TITLE_PHRASE =
  /\b(?:jingle bells?|sleigh ride|winter wonderland|let it snow|frosty the snow(?:man)?|little drummer boy|silent night|oh? holy (?:nighte?|nite)|deck the halls?|carol of the bells|fairytale of new york|wizards in winter|baby it'?s cold outside|most wonderful time|chestnuts roasting|have yourself a merry|we wish you a merry|underneath the tree|santa tell me|santa baby|santa claus|here comes santa|not tonight santa|run rudolph|up on the house(?:top)?|must be santa|grandma got run over|white christmas|blue christmas|feliz navidad|the first no[eë]l|little saint nick|auld lang syne|my only wish|rudolph(?: the red-?nosed)?|silver bells?|away in a manger|hark!? the herald|o come all ye faithful|adeste fideles|o come,? o come,? emmanuel|mary did you know|we three kings|what child is this|god rest ye merry|good king wenceslas|angels we have heard|o? ?little town of bethlehem|it came upon(?: a midnight)?|do you hear what i hear|polar express|mrs\.? claus|in the bleak midwinter|coventry carol|when a child is born|holly jolly|candy cane|saint nick(?:olas)?)\b/i;

const HOLIDAY_ALBUM_PHRASE =
  /\b(?:holiday (?:hits|songs|classics|collection|album|spirits|special|soundtrack)|wrapped in red|christmas|polar express|no[eë]l|when christmas comes around|nightmare before christmas|how the grinch|charlie brown christmas|rudolph)\b/i;

const SANTA_PLACE =
  /\bsanta\s+(?:monica|fe|barbara|ana|cruz|clara|rosa|maria|clarita)\b/i;

function fieldsOf(track = {}) {
  const name = String(track.name || track.title || "");
  const album = String(track.album || "");
  return { name, album, haystack: `${name} ${album}`.trim() };
}

function titleHasSanta(name) {
  if (!/\bsanta\b/i.test(name)) return false;
  return !SANTA_PLACE.test(name);
}

/** True when a playlist name is a Christmas / Hanukkah / similar holiday set. */
export function isHolidayPlaylistName(name) {
  return /christmas|x-?mas|hanukkah|hannukah|chanukah|kwanzaa|navidad|yuletide/i.test(
    String(name || "")
  );
}

/** True when title/album looks like a Christmas (or similar seasonal) song. */
export function isHolidayTrack(track = {}) {
  const { name, album, haystack } = fieldsOf(track);
  if (!haystack) return false;
  if (HOLIDAY_PHRASE.test(haystack)) return true;
  if (HOLIDAY_TITLE_PHRASE.test(name)) return true;
  if (titleHasSanta(name)) return true;
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

/** Whole Christmas-named playlists stay out of Random until the holiday window. */
export function isOutOfSeasonHolidayPlaylist(playlist = {}, date = new Date()) {
  if (isHolidaySeason(date)) return false;
  return isHolidayPlaylistName(playlist.name);
}
