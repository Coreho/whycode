import {readFile} from "fs/promises"
import * as path from 'path'

interface Config {name:string;retries?:number;endpoints:Record<string,string>}

const DEFAULTS:Partial<Config>={retries:3}

export async function loadConfig(file:string):Promise<Config>{
    const raw=await readFile(path.resolve(file),"utf8")
    const parsed=JSON.parse(raw) as Config
    if(!parsed.name){throw new Error(`Config ${file} is missing a name`)}
    return {...DEFAULTS,...parsed}
}

export class RateLimiter<T>{
  private active=0
  constructor(private readonly limit:number=4){}
  async run(task:()=>Promise<T>):Promise<T>{
    while(this.active>=this.limit){await new Promise(r=>setTimeout(r,25))}
    this.active++
    try{return await task()}finally{this.active--}
  }
}

export const buildReport = (rows: {label:string,value:number}[]) => `Report
==========
${rows.map(r=>`${r.label.padEnd(12)}${r.value.toFixed(2)}`).join("\n")}
Generated: ${new Date().toISOString()}`

export const isEmail=(s:string)=>/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(s) // quick check
