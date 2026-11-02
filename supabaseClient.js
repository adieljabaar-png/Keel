
// supabaseClient.js - Add your Supabase project details
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'

const SUPABASE_URL = localStorage.getItem('keel-supabase-url') || 'https://YOUR_PROJECT.supabase.co'
const SUPABASE_ANON_KEY = localStorage.getItem('keel-supabase-key') || 'YOUR_ANON_KEY'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// Auth helpers used by KEEL
export async function signUpWithKeel({name, email, password}){
  const { data, error } = await supabase.auth.signUp({
    email, password,
    options: { data: { full_name: name, consent_at: new Date().toISOString() } }
  })
  if(error) throw error
  // Also store profile
  if(data.user){
    await supabase.from('profiles').upsert({ id: data.user.id, email, full_name: name, created_at: new Date().toISOString() })
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
