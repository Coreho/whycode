#!/usr/bin/env node
const fs=require('fs')
const {join}=require("path")

function walk(dir,ext,results=[]){
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const full=join(dir,entry.name)
    if(entry.isDirectory()&&!entry.name.startsWith('.'))walk(full,ext,results)
    else if(entry.name.endsWith(ext))results.push(full)
  }
  return results
}

const files=walk(process.argv[2]||'.','.md')
console.log(`Found ${files.length} files:
${files.join('\n')}`)
module.exports={walk}
