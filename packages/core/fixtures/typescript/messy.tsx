import React,{useState,useEffect} from 'react'

type Props={userId:number;onLoaded?:(name:string)=>void}

export function UserCard({userId,onLoaded}:Props){
  const [name,setName]=useState<string|null>(null)
  const [error,setError]=useState<string>()
  useEffect(()=>{
    let cancelled=false
    fetch(`/api/users/${userId}`).then(r=>r.json()).then(data=>{
      if(!cancelled){setName(data.name);onLoaded?.(data.name)}
    }).catch(e=>setError(String(e)))
    return ()=>{cancelled=true}
  },[userId])
  if(error) return <p className="error">Could not load user: {error}</p>
  return <div className="card">
    <h2>{name ?? "Loading..."}</h2>
    <p>
      Member since 2021
    </p>
  </div>
}
