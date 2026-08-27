import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('the acceptance deployment wires the hosted-room facet through governance', async () => {
  const source = await readFile(new URL('../src/deployment.ts', import.meta.url), 'utf8')

  assert.match(source, /RoomPoolHostingFacet\.sol\/RoomPoolHostingFacet\.json/)
  assert.match(source, /const hostingFacet = await deploy\(hostingFacetArtifact\)/)
  assert.match(
    source,
    /await throughTimelock\([\s\S]*?'configureHostingFacet',[\s\S]*?\[hostingFacet\],[\s\S]*?'pool-hosting-facet'/,
  )
})
