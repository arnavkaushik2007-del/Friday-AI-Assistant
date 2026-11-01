// Quick check: which free voice engine works on this machine right now?
import fs from 'node:fs';
import path from 'node:path';
import { speak, voiceStatus } from '../src/tts.js';
import { DATA_DIR } from '../src/config.js';

console.log('voice status:', voiceStatus());

const samples = [
  { lang: 'en', text: 'Good evening boss. All systems are online and I am ready when you are.' },
  { lang: 'hi', text: 'नमस्ते बॉस, मैं फ्राइडे हूँ। बताइए, आज क्या काम करना है?' }
];

for (const sample of samples) {
  const started = Date.now();
  try {
    const out = await speak(sample.text, { lang: sample.lang, engine: 'auto' });
    if (out.browser) {
      console.log(`BROWSER ${sample.lang}`);
      continue;
    }
    const ext = out.mime === 'audio/wav' ? 'wav' : 'mp3';
    const file = path.join(DATA_DIR, `tts-test-${sample.lang}.${ext}`);
    fs.writeFileSync(file, out.audio);
    console.log(`OK  ${sample.lang} via ${out.engine}: ${out.audio.length} bytes in ${Date.now() - started}ms -> ${file}`);
  } catch (err) {
    console.log(`FAIL ${sample.lang}: ${err.message}`);
  }
}
