// supabaseClient.js - KEEL v1.5 with location sharing + health profiles
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'

export const SUPABASE_URL = 'https://xljdbzkzslyzonfovkbo.supabase.co'
export const SUPABASE_ANON_KEY = 'sb_publishable_3KuVZltsOKHpMgh1x7ZSTg_ZuRKtmZr'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

export async function signUpWithKeel({name, email, password}){
  const { data, error } = await supabase.auth.signUp({
    email, password,
    options: { data: { full_name: name, consent_at: new Date().toISOString() } }
  })
  if(error) throw error
  if(data.user){
    try { 
      await supabase.from('profiles').upsert({ 
        id: data.user.id, 
        email, 
        full_name: name, 
        share_location: false,
        created_at: new Date().toISOString() 
      }) 
    } catch(e){ console.warn('profile upsert', e) }
  }
  return data
}

export async function signInWithKeel(email, password){
  const { data, error } = await supabase.auth.signInWithPassword({email, password})
  if(error) throw error
  return data
}

export async function getSession(){
  const { data } = await supabase.auth.getSession()
  return data.session
}

export async function getProfile(userId){
  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).single()
  if(error) throw error
  return data
}

export async function updateLocationSharing(userId, {share, lat, lng}){
  const { error } = await supabase.from('profiles').upsert({
    id: userId,
    share_location: share,
    lat, lng,
    last_seen: new Date().toISOString()
  })
  if(error) throw error
}

export async function fetchNearbyPublicUsers(myLat, myLng, radiusKm=5){
  const { data, error } = await supabase.from('profiles').select('id, full_name, lat, lng, last_seen').eq('share_location', true)
  if(error) throw error
  // Haversine filter client-side
  const toRad = d => d*Math.PI/180
  const R=6371
  return (data||[]).filter(p=>{
    if(p.lat==null || p.lng==null) return false
    const dLat=toRad(p.lat-myLat), dLng=toRad(p.lng-myLng)
    const a=Math.sin(dLat/2)**2 + Math.cos(toRad(myLat))*Math.cos(toRad(p.lat))*Math.sin(dLng/2)**2
    const c=2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a))
    const dist=R*c
    p._distKm = dist
    return dist <= radiusKm
  }).sort((a,b)=>a._distKm-b._distKm)
}
