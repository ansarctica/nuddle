import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

const OUT_JSON = path.join(ROOT, 'data', 'courses.gob.json');
const LOG_FILE = path.join(ROOT, 'logs', 'app.log');

fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });

const log = (msg) => {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (e) {
    console.error('log write failed:', e.message, msg);
  }
};

const DAYS_MAP = { M: 0, T: 1, W: 2, R: 3, F: 4, S: 5 }; 
const DAY_ORDER = ['M','T','W','R','F','S']; 

function parseTimeToSlot(timeStr) {
  const [raw, meridian] = timeStr.trim().split(/(?=[AP]M)/);
  let [h, m] = raw.split(':').map(Number);
  if (meridian === 'PM' && h !== 12) h += 12;
  if (meridian === 'AM' && h === 12) h = 0;
  const totalMinutes = h * 60 + m;
  const minutesSince8AM = totalMinutes - 8 * 60;
  const slot = Math.floor(minutesSince8AM / 30);
  return Math.max(0, Math.min(31, slot));
}

function timeRecordToBitmask(tRec) {
  const bytes = new Uint8Array(24); 
  try {
    const parts = tRec.trim().split(' ');
    const days = parts[0]; 
    const [startStr, endStr] = parts.slice(1).join(' ').split('-').map(s => s.trim());

    const startSlot = parseTimeToSlot(startStr);

    let endSlot;
    const endMinutes = (() => {
      const [raw, meridian] = endStr.trim().split(/(?=[AP]M)/);
      let [h, m] = raw.split(':').map(Number);
      if (meridian === 'PM' && h !== 12) h += 12;
      if (meridian === 'AM' && h === 12) h = 0;
      return h * 60 + m;
    })();
    endSlot = Math.ceil((endMinutes - 8 * 60) / 30);
    endSlot = Math.max(startSlot + 1, endSlot);
    endSlot = Math.min(endSlot, 32);

    for (const d of days) {
      const dayIndex = DAYS_MAP[d];
      if (dayIndex == null) continue;
      const offset = dayIndex * 32;
      for (let i = startSlot; i < endSlot; i++) {
        const bitIndex = offset + i;
        bytes[bitIndex >> 3] |= 1 << (bitIndex & 7);
      }
    }
  } catch {
      }
  return Array.from(bytes);
}


function splitTimeRecord(tRec) {
    try {
    const s = String(tRec || '').trim();
    const parts = s.split(' ');
    const days = (parts[0] || '').replace(/[^MTWRFS]/g, '');
    const range = parts.slice(1).join(' ').trim(); 
    if (!days || !range || !range.includes('-')) return null;
    const set = new Set();
    for (const ch of days) if (DAY_ORDER.includes(ch)) set.add(ch);
    return { days: set, range };
  } catch {
    return null;
  }
}

function mergeTimeRecords(a, b) {
    const pa = splitTimeRecord(a);
  const pb = splitTimeRecord(b);
  if (pa && pb && pa.range === pb.range) {
    const mergedDays = new Set([...pa.days, ...pb.days]);
    const daysStr = DAY_ORDER.filter(d => mergedDays.has(d)).join('');
    return `${daysStr} ${pa.range}`;
  }
    const parts = new Set();
  if (a) parts.add(a);
  if (b) parts.add(b);
  return Array.from(parts).join('; ');
}

function orBits24(a, b) {
  const out = new Array(24).fill(0);
  for (let i = 0; i < 24; i++) {
    const ai = (a && a[i]) | 0;
    const bi = (b && b[i]) | 0;
    out[i] = ai | bi;
  }
  return out;
}

function normalizeProfessors(a, b) {
  const set = new Set();
  for (const s of [a, b]) {
    const v = String(s || '').trim();
    if (v) v.split(',').map(x => x.trim()).forEach(x => x && set.add(x));
  }
  return Array.from(set).join(', ');
}

function mergeSessionsSameNameAndType(sessions) {
      const map = new Map();
  for (const s of sessions) {
    const type = (s.SESSION_TYPE ?? String(s.SESSION_NAME || '').replace(/[0-9]/g, '')).trim();
    const name = String(s.SESSION_NAME || '').trim();
    const key = `${type}::${name}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...s, SESSION_TYPE: type, SESSION_NAME: name });
      continue;
    }
    prev.TIME_BITS = orBits24(prev.TIME_BITS, s.TIME_BITS);
    prev.TIME_RECORD = mergeTimeRecords(prev.TIME_RECORD, s.TIME_RECORD);
    prev.PROFESSOR = normalizeProfessors(prev.PROFESSOR, s.PROFESSOR);
    prev.AVAILABILITY = Number(Boolean(prev.AVAILABILITY) || Boolean(s.AVAILABILITY));
    if (!prev.ENROLLMENT && s.ENROLLMENT) prev.ENROLLMENT = s.ENROLLMENT;
        if (Number(s.TIME_RELEVANCE) === 0) prev.TIME_RELEVANCE = 0;
  }
  return Array.from(map.values());
}


async function setUp() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  log('Opened browser and navigating to course catalog...');
  await page.goto('https://registrar.nu.edu.kz/course-catalog', { waitUntil: 'domcontentloaded' });

  await page.selectOption('#semesterComboId', { index: 1 });
  await page.click('#search-opt-div > div:nth-child(5) > div.optionTitle.inactive > span');
  await page.selectOption('#levelComboId', { index: 5 });
  await page.waitForSelector('#limitComboIdTop');
  await page.selectOption('#limitComboIdTop', { index: 5 });
  return { browser, page };
}

async function scrape(page) {
  let currentPage = 1;
  const all = [];

  while (true) {
    const pageSelect = await page.$('#pageComboIdTop');
    if (!pageSelect) {
      log(`Could not find page selector at page ${currentPage}`);
      break;
    }

    try {
      await page.selectOption('#pageComboIdTop', String(currentPage));
      log(`Switched to page ${currentPage}`);
    } catch (e) {
      log(`Failed to select page ${currentPage}: ${e.message}`);
      break;
    }

    await page.waitForTimeout(4000);

    let courseDivs;
    try {
      await page.waitForSelector('#searchResultDiv > div', { timeout: 10000 });
      courseDivs = await page.$$('#searchResultDiv > div');
      if (!courseDivs.length) {
        log(` No course results on page ${currentPage}, stopping.`);
        break;
      }
    } catch {
      log(` Timeout waiting for results on page ${currentPage}, stopping.`);
      break;
    }

    for (const div of courseDivs) {
      try {
        const name = await div.$eval('table > tbody > tr:nth-child(1) > td:nth-child(1)', el => el.innerText.trim());
        const credits = await div.$eval('table > tbody > tr:nth-child(1) > td:nth-child(4)', el => el.innerText.trim());

        log(`Scraping course: ${name}`);

        if (await div.$('table > tbody > tr:nth-child(2) span')) {
          await (await div.$('table > tbody > tr:nth-child(2) span')).click();
          try {
            await div.waitForSelector('[id^="scheduleDiv"] table tbody tr:nth-child(2)', { timeout: 3000 });
          } catch {
            log(`No session rows found after expanding course "${name}"`);
          }
        }

        const rawSessions = [];
        const rows = await div.$$('[id^="scheduleDiv"] > div > table > tbody > tr:not(:first-child)');
        for (const row of rows) {
          try {
            const tds = await row.$$('td');
            if (tds.length < 4) continue;

            const sName = (await tds[0].innerText()).trim();
            const tRec  = (await tds[1].innerText()).trim();
            const enroll= (await tds[2].innerText()).trim();
            const prof  = (await tds[3].innerText()).trim();

            const bits = timeRecordToBitmask(tRec);
            log(`Session raw: ${sName} | ${tRec}`);

            rawSessions.push({
              SESSION_NAME: sName,
              SESSION_TYPE: sName.replace(/[0-9]/g, '').trim(),
              TIME_RECORD: tRec,
              TIME_RELEVANCE: tRec.includes('PM 11') ? 0 : 1, 
              TIME_BITS: bits,
              ENROLLMENT: enroll,
              AVAILABILITY: +(enroll.split('/')[0] !== enroll.split('/')[1]),
              PROFESSOR: prof,
            });
          } catch (err) {
            log(`Failed to parse session row: ${err.message}`);
          }
        }

        
        const merged = mergeSessionsSameNameAndType(rawSessions);

        all.push({
          COURSE_NAME: name,
          COURSE_CREDITS: credits,
          COURSE_SESSIONS: merged,
        });
      } catch (e) {
        log(`Error parsing course: ${e.message}`);
      }
    }

    currentPage += 1;
  }

  return all;
}

(async () => {
  const { browser, page } = await setUp();
  try {
    const data = await scrape(page);
    fs.writeFileSync(OUT_JSON, JSON.stringify(data, null, 2));
    log(`Wrote ${data.length} courses to ${OUT_JSON}`);
  } catch (e) {
    log(`! ${e.message}`);
  } finally {
    await browser.close();
  }
})();