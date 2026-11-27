const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { v2: cloudinary } = require('cloudinary');
const { query, pool } = require('./pool');
const scrypt = promisify(crypto.scrypt);
const MAX_BYTES = 20 * 1024 * 1024;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

function reply(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}
function cookie(req) {
  const item = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('cc_admin='));
  return item ? decodeURIComponent(item.slice(9)) : '';
}
function slug(value) {
  return String(value || '').normalize('NFKD').toLowerCase().replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90);
}
function body(req, max = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > max) reject(Object.assign(new Error('Request too large.'), { status: 413 })); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(Object.assign(new Error('Invalid JSON body.'), { status: 400 })); } });
    req.on('error', reject);
  });
}
async function adminFor(req) {
  const token = cookie(req);
  if (!token) return null;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const r = await query('SELECT a.id,a.email,a.display_name,a.role FROM admin_sessions s JOIN admins a ON a.id=s.admin_id WHERE s.token_hash=$1 AND s.expires_at>NOW() AND a.is_active=TRUE', [hash]);
  return r.rows[0] || null;
}
async function requireAdmin(req, res) {
  const admin = await adminFor(req);
  if (!admin) reply(res, 401, { error: 'Administrator sign-in required.' });
  return admin;
}
async function bootstrapAdmin() {
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || '');
  if (!email || !password) return;
  const exists = await query('SELECT id FROM admins WHERE email=$1', [email]);
  if (exists.rowCount) return;
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 64)).toString('hex');
  await query("INSERT INTO admins(email,password_hash,display_name,role) VALUES($1,$2,$3,'owner') ON CONFLICT(email) DO NOTHING", [email, 'scrypt:' + salt + ':' + hash, email.split('@')[0]]);
}
async function audit(admin, action, id, details = {}) {
  await query("INSERT INTO admin_audit_logs(admin_id,action,entity_type,entity_id,details) VALUES($1,$2,'document',$3,$4::jsonb)", [admin.id, action, id ? String(id) : null, JSON.stringify(details)]);
}
const SELECT = "SELECT d.*,u.name university_name,cp.name campus_name,f.name faculty_name,c.name course_name,un.name unit_name,un.code unit_code FROM documents d JOIN universities u ON u.id=d.university_id LEFT JOIN campuses cp ON cp.id=d.campus_id LEFT JOIN faculties f ON f.id=d.faculty_id LEFT JOIN courses c ON c.id=d.course_id LEFT JOIN units un ON un.id=d.unit_id";
function shape(d) {
  return { id:d.id,title:d.title,description:d.description,type:d.document_type,academicYear:d.academic_year,semester:d.semester,examSession:d.exam_session,fileName:d.original_file_name,fileSize:Number(d.file_size_bytes || 0),previewUrl:d.preview_image_url,downloadUrl:'/api/documents/'+d.id+'/download',accessTier:d.access_tier,price:Number(d.price_minor || 0)/100,downloadCount:Number(d.download_count || 0),university:d.university_name,campus:d.campus_name,faculty:d.faculty_name,course:d.course_name,unit:d.unit_name,unitCode:d.unit_code,createdAt:d.created_at };
}
async function ensureNamed(client, table, universityId, name) {
  if (!name) return null;
  const result = await client.query('INSERT INTO '+table+'(university_id,name,slug) VALUES($1,$2,$3) ON CONFLICT(university_id,slug) DO UPDATE SET name=EXCLUDED.name RETURNING id', [universityId, String(name).trim(), slug(name)]);
  return result.rows[0].id;
}
async function uploadDocument(admin, data) {
  if (!String(data.title || '').trim()) throw Object.assign(new Error('Document title is required.'), { status:400 });
  const publicId = String(data.cloudinaryPublicId || '');
  if (!publicId.startsWith('coursecorrect/')) throw Object.assign(new Error('Upload the PDF through the signed upload flow first.'), { status:400 });
  const asset = await cloudinary.api.resource(publicId, { resource_type:'raw' });
  if (!asset || asset.resource_type !== 'raw' || Number(asset.bytes) > MAX_BYTES || !String(asset.format || '').toLowerCase().includes('pdf')) {
    throw Object.assign(new Error('Cloudinary asset is not an accepted PDF.'), { status:400 });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const universityName = String(data.university || 'Mount Kenya University').trim();
    const uni = await client.query('INSERT INTO universities(name,slug) VALUES($1,$2) ON CONFLICT(slug) DO UPDATE SET name=EXCLUDED.name,updated_at=NOW() RETURNING id', [universityName, slug(universityName)]);
    const universityId = uni.rows[0].id;
    const campusId = await ensureNamed(client,'campuses',universityId,data.campus);
    const facultyId = await ensureNamed(client,'faculties',universityId,data.faculty);
    let courseId = null, unitId = null;
    if (data.course) {
      const course = await client.query('INSERT INTO courses(university_id,faculty_id,name,slug) VALUES($1,$2,$3,$4) ON CONFLICT(university_id,slug) DO UPDATE SET faculty_id=EXCLUDED.faculty_id,name=EXCLUDED.name RETURNING id', [universityId,facultyId,String(data.course).trim(),slug(data.course)]);
      courseId = course.rows[0].id;
    }
    if (data.unit && courseId) {
      const unit = await client.query('INSERT INTO units(course_id,code,name,slug,year_of_study,semester) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(course_id,slug) DO UPDATE SET code=EXCLUDED.code,name=EXCLUDED.name RETURNING id', [courseId,data.unitCode || null,String(data.unit).trim(),slug(data.unit),data.yearOfStudy || null,data.semester || null]);
      unitId = unit.rows[0].id;
    }
    const types = ['past_paper','cat','assignment','notes','marking_scheme','revision','other'];
    const docType = types.includes(data.type) ? data.type : 'other';
    const inserted = await client.query("INSERT INTO documents(university_id,campus_id,faculty_id,course_id,unit_id,title,description,document_type,academic_year,semester,exam_session,original_file_name,mime_type,file_size_bytes,cloudinary_public_id,cloudinary_asset_id,cloudinary_url,preview_image_url,access_tier,price_minor,status,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'application/pdf',$13,$14,$15,$16,$17,'free',0,'published',$18) RETURNING id", [universityId,campusId,facultyId,courseId,unitId,String(data.title).trim(),data.description || null,docType,Number(data.academicYear)||new Date().getFullYear(),Number(data.semester)||null,data.examSession||null,String(data.fileName||'resource.pdf').replace(/[^\w.\- ()]/g,'_'),Number(asset.bytes),asset.public_id,asset.asset_id,asset.secure_url,data.previewImageUrl||null,admin.id]);
    await audit(admin,'document.create',inserted.rows[0].id,{title:data.title});
    await client.query('COMMIT');
    return inserted.rows[0].id;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

module.exports = async function handle(req,res,pathname,url) {
  if (pathname !== '/api/catalog' && pathname !== '/api/materials' && !pathname.startsWith('/api/admin') && !pathname.startsWith('/api/documents/')) return false;
  const method = req.method || 'GET';
  if (method === 'OPTIONS') { res.writeHead(204,{'Access-Control-Allow-Methods':'GET,POST,PATCH,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type'}); res.end(); return true; }
  try {
    if ((pathname === '/api/catalog' || pathname === '/api/materials') && method === 'GET') {
      const values=[], filters=["d.status='published'"];
      const q=(url.searchParams.get('q')||'').trim();
      if(q){ values.push('%'+q+'%'); const n=values.length; filters.push("(d.title ILIKE $"+n+" OR d.description ILIKE $"+n+" OR d.original_file_name ILIKE $"+n+" OR EXISTS(SELECT 1 FROM units x WHERE x.id=d.unit_id AND (x.name ILIKE $"+n+" OR x.code ILIKE $"+n+")))"); }
      const university=url.searchParams.get('university'); if(university){values.push(university);filters.push('u.slug=$'+values.length);}
      const type=url.searchParams.get('type'); if(type){values.push(type);filters.push('d.document_type=$'+values.length);}
      const year=Number(url.searchParams.get('year')); if(year){values.push(year);filters.push('d.academic_year=$'+values.length);}
      const result=await query(SELECT+' WHERE '+filters.join(' AND ')+' ORDER BY d.created_at DESC LIMIT 100',values);
      const facets=await query("SELECT u.name university,f.name faculty,d.document_type type,COUNT(*)::int count FROM documents d JOIN universities u ON u.id=d.university_id LEFT JOIN faculties f ON f.id=d.faculty_id WHERE d.status='published' GROUP BY u.name,f.name,d.document_type ORDER BY u.name,f.name,d.document_type");
      reply(res,200,{total:result.rowCount,documents:result.rows.map(shape),facets:facets.rows}); return true;
    }
    if(pathname==='/api/admin/login' && method==='POST'){
      await bootstrapAdmin(); const input=await body(req,12000);
      const found=await query('SELECT * FROM admins WHERE email=$1 AND is_active=TRUE',[String(input.email||'').trim().toLowerCase()]);
      const admin=found.rows[0]; let valid=false;
      if(admin && admin.password_hash.startsWith('scrypt:')){const parts=admin.password_hash.split(':');const actual=await scrypt(String(input.password||''),parts[1],64);valid=crypto.timingSafeEqual(actual,Buffer.from(parts[2],'hex'));}
      if(!valid){reply(res,401,{error:'Email or password is incorrect.'});return true;}
      const token=crypto.randomBytes(32).toString('base64url'), hash=crypto.createHash('sha256').update(token).digest('hex');
      await query("INSERT INTO admin_sessions(admin_id,token_hash,expires_at) VALUES($1,$2,NOW()+INTERVAL '7 days')",[admin.id,hash]);
      await query('UPDATE admins SET last_login_at=NOW() WHERE id=$1',[admin.id]);
      reply(res,200,{success:true,admin:{email:admin.email,name:admin.display_name,role:admin.role}},{'Set-Cookie':'cc_admin='+encodeURIComponent(token)+'; Path=/; HttpOnly; '+(process.env.VERCEL?'Secure; ':'')+'SameSite=Lax; Max-Age=604800'});return true;
    }
    if(pathname==='/api/admin/logout' && method==='POST'){
      const token=cookie(req);if(token)await query('DELETE FROM admin_sessions WHERE token_hash=$1',[crypto.createHash('sha256').update(token).digest('hex')]);
      reply(res,200,{success:true},{'Set-Cookie':'cc_admin=; Path=/; HttpOnly; '+(process.env.VERCEL?'Secure; ':'')+'SameSite=Lax; Max-Age=0'});return true;
    }
    if(pathname==='/api/admin/me' && method==='GET'){
      const admin=await adminFor(req);reply(res,admin?200:401,admin?{admin:{email:admin.email,name:admin.display_name,role:admin.role}}:{error:'Not signed in.'});return true;
    }
    if(pathname==='/api/admin/upload-signature' && method==='POST'){
      const admin=await requireAdmin(req,res);if(!admin)return true;
      if(!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) throw new Error('Cloudinary environment variables are not configured.');
      const timestamp=Math.floor(Date.now()/1000);
      const publicId='coursecorrect/uploads/'+Date.now()+'-'+crypto.randomBytes(6).toString('hex');
      const params={public_id:publicId,timestamp:timestamp,tags:'coursecorrect,academic-resource'};
      const signature=cloudinary.utils.api_sign_request(params,process.env.CLOUDINARY_API_SECRET);
      reply(res,200,{cloudName:process.env.CLOUDINARY_CLOUD_NAME,apiKey:process.env.CLOUDINARY_API_KEY,timestamp,publicId,signature,resourceType:'raw',tags:params.tags});return true;
    }
    if(pathname==='/api/admin/activity' && method==='GET'){
      const admin=await requireAdmin(req,res);if(!admin)return true;
      const rows=await query("SELECT l.action,l.entity_type,l.entity_id,l.details,l.created_at,a.display_name FROM admin_audit_logs l LEFT JOIN admins a ON a.id=l.admin_id ORDER BY l.created_at DESC LIMIT 100");
      reply(res,200,{activity:rows.rows});return true;
    }
    if(pathname==='/api/admin/documents' && method==='GET'){
      const admin=await requireAdmin(req,res);if(!admin)return true;
      const docs=await query(SELECT+' ORDER BY d.created_at DESC LIMIT 250');reply(res,200,{documents:docs.rows.map(shape)});return true;
    }
    if(pathname==='/api/admin/documents' && method==='POST'){
      const admin=await requireAdmin(req,res);if(!admin)return true;
      const id=await uploadDocument(admin,await body(req));const doc=await query(SELECT+' WHERE d.id=$1',[id]);reply(res,201,{success:true,document:shape(doc.rows[0])});return true;
    }
    const idMatch=pathname.match(/^\/api\/admin\/documents\/([0-9a-f-]+)$/i);
    if(idMatch && method==='PATCH'){
      const admin=await requireAdmin(req,res);if(!admin)return true;const input=await body(req,12000);
      const allowed=['title','description','academic_year','semester','exam_session','status','access_tier','price_minor'],sets=[],vals=[];
      for(const key of allowed)if(input[key]!==undefined){vals.push(input[key]);sets.push(key+'=$'+vals.length);}
      if(!sets.length){reply(res,400,{error:'No editable fields supplied.'});return true;}
      vals.push(idMatch[1]);const changed=await query('UPDATE documents SET '+sets.join(',')+',updated_at=NOW() WHERE id=$'+vals.length+' RETURNING id',vals);
      if(!changed.rowCount){reply(res,404,{error:'Document not found.'});return true;}
      await audit(admin,'document.update',idMatch[1],input);const doc=await query(SELECT+' WHERE d.id=$1',[idMatch[1]]);reply(res,200,{success:true,document:shape(doc.rows[0])});return true;
    }
    if(idMatch && method==='DELETE'){
      const admin=await requireAdmin(req,res);if(!admin)return true;
      const old=await query('SELECT cloudinary_public_id FROM documents WHERE id=$1',[idMatch[1]]);
      if(!old.rowCount){reply(res,404,{error:'Document not found.'});return true;}
      await query('DELETE FROM documents WHERE id=$1',[idMatch[1]]);await audit(admin,'document.delete',idMatch[1]);
      try{await cloudinary.uploader.destroy(old.rows[0].cloudinary_public_id,{resource_type:'raw',invalidate:true});}catch(e){console.error('[Cloudinary] delete:',e.message);}
      reply(res,200,{success:true});return true;
    }
    const download=pathname.match(/^\/api\/documents\/([0-9a-f-]+)\/download$/i);
    if(download && method==='GET'){
      const doc=await query("SELECT cloudinary_url,access_tier,status FROM documents WHERE id=$1",[download[1]]);
      if(!doc.rowCount || doc.rows[0].status!=='published'){reply(res,404,{error:'Document not found.'});return true;}
      if(doc.rows[0].access_tier!=='free'){reply(res,402,{error:'This resource is not available in the free launch.'});return true;}
      await query('UPDATE documents SET download_count=download_count+1 WHERE id=$1',[download[1]]);
      res.writeHead(302,{Location:doc.rows[0].cloudinary_url,'Cache-Control':'no-store'});res.end();return true;
    }
    reply(res,405,{error:'Method not allowed.'});return true;
  } catch(error){console.error('[CourseCorrect API]',error.message);reply(res,error.status||500,{error:error.status?error.message:'The request could not be completed.'});return true;}
};
