import { readFile, writeFile } from 'node:fs/promises'
import { createOfficeLayout } from '../src/office-layout.js'

try {
  const catalog = JSON.parse(await readFile(new URL('../assets/styles/topdown-soft/style.json', import.meta.url), 'utf8'))
  const map = createOfficeLayout(catalog)
  const output = new URL('../examples/office-10-person.json', import.meta.url)
  await writeFile(output, `${JSON.stringify(map, null, 2)}\n`)
  console.log(`Generated ${output.pathname}: ${map.seats.length} workstations, ${map.rooms.filter(r => r.type === 'meeting').length} meeting rooms, pantry + restroom, ${map.elements.length} editable components; no office background.`)
} catch (error) {
  console.error(`Office example generation failed: ${error.message}`)
  process.exitCode = 1
}
