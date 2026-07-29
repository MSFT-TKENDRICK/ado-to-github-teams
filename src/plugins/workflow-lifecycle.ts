import {definePlugin} from 'nitro'
import {closeWorld} from '../worker.js'

export default definePlugin((nitroApp) => {
  nitroApp.hooks.hook('close', closeWorld)
})
