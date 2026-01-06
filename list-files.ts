import fs from 'fs'
import path from 'path'

export function listFiles(dirPath, arrayOfFiles: string[] = []) {
  const files = fs.readdirSync(dirPath)

  files.forEach((file) => {
    const fullPath: string = path.join(dirPath, file)
    if (fs.statSync(fullPath).isDirectory()) {
      arrayOfFiles = listFiles(fullPath, arrayOfFiles)
    } else {
      arrayOfFiles.push(fullPath)
    }
  })

  return arrayOfFiles
}

