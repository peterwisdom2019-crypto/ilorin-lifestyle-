const express=require("express");
const path=require("path");
const bcrypt=require("bcryptjs");
const session=require("express-session");
const pgSession=require("connect-pg-simple")(session);
const {Pool}=require("pg");
const app=express(), PORT=process.env.PORT||3000;

if(!process.env.DATABASE_URL){console.error("DATABASE_URL is missing.");process.exit(1);}
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
app.set("trust proxy",1);
app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use(session({
  store:new pgSession({pool,tableName:"user_sessions",createTableIfMissing:true}),
  secret:process.env.SESSION_SECRET||"change-this-session-secret-in-render",
  resave:false,saveUninitialized:false,
  cookie:{httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"lax",maxAge:2592000000}
}));
app.use(express.static(path.join(__dirname,"public")));

async function initDb(){
 await pool.query(`CREATE TABLE IF NOT EXISTS users(
 id SERIAL PRIMARY KEY,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,
 display_name TEXT NOT NULL,avatar_url TEXT DEFAULT '',bio TEXT DEFAULT '',
 created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW())`);
 await pool.query(`CREATE TABLE IF NOT EXISTS follows(
 follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 following_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at TIMESTAMPTZ DEFAULT NOW(),
 PRIMARY KEY(follower_id,following_id),CHECK(follower_id<>following_id))`);
 await pool.query(`CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id)`);
}
function auth(req,res,next){if(!req.session.userId)return res.status(401).json({error:"Please log in first."});next();}

app.get("/api/health",async(req,res)=>{try{await pool.query("SELECT 1");res.json({ok:true,database:"connected"});}catch(e){res.status(500).json({ok:false});}});
app.get("/api/me",async(req,res)=>{
 if(!req.session.userId)return res.json({user:null});
 const r=await pool.query("SELECT id,email,display_name,avatar_url,bio,created_at FROM users WHERE id=$1",[req.session.userId]);
 res.json({user:r.rows[0]||null});
});
app.post("/api/register",async(req,res)=>{
 try{
  const name=String(req.body.displayName||"").trim(),email=String(req.body.email||"").trim().toLowerCase(),pw=String(req.body.password||"");
  if(name.length<2||name.length>80)return res.status(400).json({error:"Display name must be 2â80 characters."});
  if(!email.includes("@"))return res.status(400).json({error:"Enter a valid email."});
  if(pw.length<8)return res.status(400).json({error:"Password must be at least 8 characters."});
  if((await pool.query("SELECT id FROM users WHERE email=$1",[email])).rows.length)return res.status(409).json({error:"An account with that email already exists."});
  const hash=await bcrypt.hash(pw,12);
  const r=await pool.query("INSERT INTO users(email,password_hash,display_name) VALUES($1,$2,$3) RETURNING id,email,display_name,avatar_url,bio,created_at",[email,hash,name]);
  req.session.userId=r.rows[0].id;res.status(201).json({user:r.rows[0]});
 }catch(e){console.error(e);res.status(500).json({error:"Could not create account."});}
});
app.post("/api/login",async(req,res)=>{
 try{
  const email=String(req.body.email||"").trim().toLowerCase(),pw=String(req.body.password||"");
  const r=await pool.query("SELECT id,email,password_hash,display_name,avatar_url,bio,created_at FROM users WHERE email=$1",[email]);
  const u=r.rows[0];
  if(!u||!(await bcrypt.compare(pw,u.password_hash)))return res.status(401).json({error:"Incorrect email or password."});
  req.session.userId=u.id;delete u.password_hash;res.json({user:u});
 }catch(e){res.status(500).json({error:"Could not log in."});}
});
app.post("/api/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.put("/api/profile",auth,async(req,res)=>{
 try{
  const name=String(req.body.displayName||"").trim(),bio=String(req.body.bio||"").trim(),avatar=String(req.body.avatarUrl||"").trim();
  if(name.length<2||name.length>80)return res.status(400).json({error:"Display name must be 2â80 characters."});
  if(bio.length>500)return res.status(400).json({error:"Bio must be 500 characters or less."});
  const r=await pool.query("UPDATE users SET display_name=$1,bio=$2,avatar_url=$3,updated_at=NOW() WHERE id=$4 RETURNING id,email,display_name,avatar_url,bio,created_at",[name,bio,avatar,req.session.userId]);
  res.json({user:r.rows[0]});
 }catch(e){res.status(500).json({error:"Could not save profile."});}
});
app.get("/api/members",async(req,res)=>{
 try{
  const q=String(req.query.search||"").trim(),uid=req.session.userId||0;
  const r=await pool.query(`SELECT u.id,u.display_name,u.avatar_url,u.bio,u.created_at,
   EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=$1 AND f.following_id=u.id) AS is_following,
   (SELECT COUNT(*)::int FROM follows f2 WHERE f2.following_id=u.id) AS followers_count
   FROM users u WHERE ($2='' OR u.display_name ILIKE '%'||$2||'%')
   ORDER BY u.created_at DESC LIMIT 50`,[uid,q]);
  res.json({members:r.rows});
 }catch(e){res.status(500).json({error:"Could not load members."});}
});
app.post("/api/follow/:id",auth,async(req,res)=>{
 try{
  const id=Number(req.params.id);
  if(!Number.isInteger(id)||id===req.session.userId)return res.status(400).json({error:"Invalid member."});
  if(!(await pool.query("SELECT id FROM users WHERE id=$1",[id])).rows.length)return res.status(404).json({error:"Member not found."});
  await pool.query("INSERT INTO follows(follower_id,following_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[req.session.userId,id]);
  res.json({following:true});
 }catch(e){res.status(500).json({error:"Could not follow member."});}
});
app.delete("/api/follow/:id",auth,async(req,res)=>{
 try{await pool.query("DELETE FROM follows WHERE follower_id=$1 AND following_id=$2",[req.session.userId,Number(req.params.id)]);res.json({following:false});}
 catch(e){res.status(500).json({error:"Could not unfollow member."});}
});
app.get("/api/following",auth,async(req,res)=>{
 const r=await pool.query(`SELECT u.id,u.display_name,u.avatar_url,u.bio FROM follows f JOIN users u ON u.id=f.following_id WHERE f.follower_id=$1 ORDER BY f.created_at DESC`,[req.session.userId]);
 res.json({members:r.rows});
});
app.get("/account",(req,res)=>res.sendFile(path.join(__dirname,"public","account.html")));
app.get("/social",(req,res)=>res.sendFile(path.join(__dirname,"public","social.html")));
app.get("/{*splat}",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

initDb().then(()=>app.listen(PORT,()=>console.log("Ilorin Lifestyle running on "+PORT)))
.catch(e=>{console.error("Database initialization failed:",e);process.exit(1);});
