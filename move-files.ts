import { listFiles } from './list-files'
import {$} from 'bun'

const files = listFiles('public/assets')

for(const file of files) {
  const result = await $`mv ${file} ${file.replace(/public-assets-/g, '')}`
  console.log(result.text())
}