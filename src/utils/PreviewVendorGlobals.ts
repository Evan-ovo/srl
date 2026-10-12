import YAML from 'yaml'
import * as z from 'zod'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'

Object.defineProperties(globalThis, {
  YAML: { configurable: true, value: YAML },
  z: { configurable: true, value: z },
  // Per opaque document: this factory has no access to the browser's persistent databases.
  __SRL_EPHEMERAL_INDEXEDDB__: { configurable: true, value: new IDBFactory() },
  __SRL_EPHEMERAL_IDB_KEY_RANGE__: { configurable: true, value: IDBKeyRange },
})
