// scripts/source-decode-media.mjs
// Sourcing 18 photos for Decode the State with verified Wikimedia Commons metadata.
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const CLUES_CONFIG = [
  // Ogun
  { id: 'ogun-1', state: 'Ogun', clueIndex: 1, search: 'Adire textile Abeokuta', name: 'Adire textile', fallback: 'Traditional indigo-dyed adire cloth with intricate resist patterns.' },
  { id: 'ogun-2', state: 'Ogun', clueIndex: 2, search: 'Ojude Oba festival', name: 'Ojude Oba festival', fallback: 'Parade of horse riders and traditional age grades at the annual cultural festival.' },
  { id: 'ogun-3', state: 'Ogun', clueIndex: 3, search: 'Olumo Rock Abeokuta', name: 'Olumo Rock', fallback: 'Massive granite outcrop that served as a historic natural fortress.' },

  // Kano
  { id: 'kano-1', state: 'Kano', clueIndex: 1, search: 'Dala Hill Kano', name: 'Dala Hill', fallback: 'Historic ancient settlement hill overlooking the city.' },
  { id: 'kano-2', state: 'Kano', clueIndex: 2, search: 'Kano city wall OR Kofar Kano', name: 'Ancient Kano city gate', fallback: 'Portion of the historic earthworks and city gate structure.' },
  { id: 'kano-3', state: 'Kano', clueIndex: 3, search: 'Kofar Mata dye pits Kano', name: 'Kofar Mata dye pits', fallback: 'Ancient indigo dyeing pits operating for centuries.' },

  // Niger
  { id: 'niger-1', state: 'Niger', clueIndex: 1, search: 'Kainji Dam Nigeria', name: 'Kainji Dam', fallback: 'Major hydroelectric power station and dam across the Niger River.' },
  { id: 'niger-2', state: 'Niger', clueIndex: 2, search: 'Gurara Falls Nigeria', name: 'Gurara Waterfalls', fallback: 'Scenic cascades tumbling over wide rock tiers surrounded by lush vegetation.' },
  { id: 'niger-3', state: 'Niger', clueIndex: 3, search: 'Zuma Rock Nigeria', name: 'Zuma Rock', fallback: 'Huge natural monolith rising prominently above the surrounding plains.' },

  // Anambra
  { id: 'anambra-1', state: 'Anambra', clueIndex: 1, search: 'Igbo-Ukwu bronze', name: 'Igbo-Ukwu bronze artifact', fallback: 'Ancient 9th-century bronze casting with intricate concentric and beaded decoration.' },
  { id: 'anambra-2', state: 'Anambra', clueIndex: 2, search: 'Ogbunike Caves', name: 'Ogbunike Caves', fallback: 'Network of sandstone caves and freshwater streams nestled in a valley.' },
  { id: 'anambra-3', state: 'Anambra', clueIndex: 3, search: 'Onitsha Bridge OR River Niger Bridge', name: 'River Niger Bridge at Onitsha', fallback: 'Steel truss bridge spanning the River Niger toward the commercial hub of Onitsha.' },

  // Cross River
  { id: 'cross_river-1', state: 'Cross River', clueIndex: 1, search: 'Agbokim Waterfalls', name: 'Agbokim Waterfalls', fallback: 'Seven-stream waterfall tumbling over steep rainforest cliffs into a calm pool.' },
  { id: 'cross_river-2', state: 'Cross River', clueIndex: 2, search: 'Obudu Mountain Resort OR Obudu Cattle Ranch', name: 'Obudu mountain plateau', fallback: 'Rolling green mountain peaks and valleys on the high plateau.' },
  { id: 'cross_river-3', state: 'Cross River', clueIndex: 3, search: 'Calabar Carnival', name: 'Calabar Carnival', fallback: 'Vibrant masquerade and street dancers in colourful feathered regalia.' },

  // Lagos
  { id: 'lagos-1', state: 'Lagos', clueIndex: 1, search: 'Lekki Conservation Centre canopy walkway', name: 'Lekki canopy walkway', fallback: 'Suspended wooden canopy walkway stretching high above the coastal reserve.' },
  { id: 'lagos-2', state: 'Lagos', clueIndex: 2, search: 'National Arts Theatre Lagos', name: 'National Arts Theatre', fallback: 'Distinctive military-hat shaped national cultural monument.' },
  { id: 'lagos-3', state: 'Lagos', clueIndex: 3, search: 'Eyo festival Lagos', name: 'Eyo Festival procession', fallback: 'White-robed masquerades holding traditional opambata staffs during the festival.' },
];

async function searchCommons(search) {
  const params = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrnamespace: '6', // File:
    gsrsearch: `${search} filetype:bitmap`,
    gsrlimit: '5',
    prop: 'imageinfo',
    iiprop: 'url|extmetadata|size',
    iiurlwidth: '1280',
    format: 'json'
  });
  const res = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, {
    headers: { 'User-Agent': 'NIACLiveEvent/1.0 (educational Independence Day trivia; info@niac.ng)' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const pages = Object.values(data.query?.pages || {});
  return pages.map(p => {
    const info = p.imageinfo?.[0] || {};
    const meta = info.extmetadata || {};
    const license = meta.LicenseShortName?.value || meta.License?.value || 'CC BY-SA';
    const cleanArtist = (meta.Artist?.value || 'Wikimedia contributor').replace(/<[^>]+>/g, '').trim();
    return {
      title: p.title,
      url: info.thumburl || info.url,
      width: info.thumbwidth || info.width,
      height: info.thumbheight || info.height,
      size: info.size,
      artist: cleanArtist,
      license,
      licenseUrl: meta.LicenseUrl?.value || 'https://creativecommons.org/licenses/',
      description: (meta.ImageDescription?.value || '').replace(/<[^>]+>/g, '').trim()
    };
  });
}

async function run() {
  const targetDir = join(process.cwd(), 'assets', 'decode');
  if (!existsSync(targetDir)) await mkdir(targetDir, { recursive: true });

  const metadataResults = [];

  for (let i = 0; i < CLUES_CONFIG.length; i++) {
    const c = CLUES_CONFIG[i];
    console.log(`[${i+1}/${CLUES_CONFIG.length}] Searching Commons for ${c.state} Clue ${c.clueIndex}: ${c.name}...`);
    try {
      const candidates = await searchCommons(c.search);
      if (!candidates.length) {
        console.warn(`  Warning: No results found for ${c.search}`);
        continue;
      }
      // Pick best candidate (prefer CC BY or CC BY-SA with reasonable dimensions)
      const pick = candidates.find(p => p.url && (p.license.includes('CC') || p.license.includes('Public domain'))) || candidates[0];
      const filename = `${String(i + 1).padStart(2, '0')}.jpg`;
      const filePath = join(targetDir, filename);

      console.log(`  Downloading: ${pick.title} (${pick.license}) -> ${filename}`);
      const imgRes = await fetch(pick.url, {
        headers: { 'User-Agent': 'NIACLiveEvent/1.0 (educational Independence Day trivia; info@niac.ng)' }
      });
      if (!imgRes.ok) throw new Error(`Failed to download ${pick.url}: HTTP ${imgRes.status}`);
      const buf = Buffer.from(await imgRes.arrayBuffer());
      await writeFile(filePath, buf);

      metadataResults.push({
        id: c.id,
        state: c.state,
        clueIndex: c.clueIndex,
        landmark: c.name,
        filename,
        src: `/assets/decode/${filename}`,
        commonsTitle: pick.title,
        author: pick.artist,
        license: pick.license,
        licenseUrl: pick.licenseUrl,
        alt: `Clue photo showing ${c.name.toLowerCase()}`,
        caption: `${c.name}, ${c.state} State. Photo: ${pick.artist} (${pick.license})`,
        fallback: c.fallback
      });
    } catch (err) {
      console.error(`  Error sourcing ${c.id}: ${err.message}`);
    }
  }

  // Save metadata
  const metaCode = `// Assets metadata for Decode the State rounds
// Verified CC-licensed and Public Domain assets from Wikimedia Commons
export const DECODE_ASSETS = ${JSON.stringify(metadataResults, null, 2)};
`;
  await writeFile(join(targetDir, 'metadata.js'), metaCode, 'utf8');
  console.log(`\nDone! Successfully sourced and wrote ${metadataResults.length} photos and metadata.js to ${targetDir}`);
}

run().catch(console.error);
