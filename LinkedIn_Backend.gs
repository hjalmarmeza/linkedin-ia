// ============================================================
//   LINKEDINMATIC — Backend Seguro (Sin claves visibles)
// ============================================================

// Recuperar claves de forma segura desde las Propiedades del Script
const props = PropertiesService.getScriptProperties();
const CLIENT_ID = props.getProperty('LINKEDIN_CLIENT_ID');
const CLIENT_SECRET = props.getProperty('LINKEDIN_CLIENT_SECRET');

const REDIRECT_URI = ScriptApp.getService().getUrl(); 
const QUEUE_FOLDER_NAME = 'Linkedinmatic_Queue';

/**
 * FUNCIÓN DE CONFIGURACIÓN INICIAL (Ejecútala una vez y bórrala)
 * Esto guarda tus claves en el servidor de Google de forma invisible.
 */
function setCredentials() {
  props.setProperty('LINKEDIN_CLIENT_ID', 'TU_CLIENT_ID_AQUÍ');
  props.setProperty('LINKEDIN_CLIENT_SECRET', 'TU_CLIENT_SECRET_AQUÍ');
  Logger.log('✅ Claves guardadas en Propiedades del Script. Ahora puedes borrar esta función.');
}

// --- PASO 1 y 2: LOGIN Y AUTORIZACIÓN ---
function doGet(e) {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return HtmlService.createHtmlOutput('<h3>Error: Falta configurar el CLIENT_ID o CLIENT_SECRET en las Propiedades del Script.</h3>');
  }

  if (e.parameter.code) {
    try {
      const payload = {
        grant_type: 'authorization_code',
        code: e.parameter.code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI
      };
      const options = {
        method: 'post',
        contentType: 'application/x-www-form-urlencoded',
        payload: payload
      };
      const response = UrlFetchApp.fetch('https://www.linkedin.com/oauth/v2/accessToken', options);
      const data = JSON.parse(response.getContentText());
      if (data.access_token) {
        props.setProperty('LINKEDIN_TOKEN', data.access_token);
        const profileResponse = UrlFetchApp.fetch('https://api.linkedin.com/v2/userinfo', {
          headers: { 'Authorization': 'Bearer ' + data.access_token }
        });
        const profileData = JSON.parse(profileResponse.getContentText());
        props.setProperty('LINKEDIN_URN', 'urn:li:person:' + profileData.sub);
        return HtmlService.createHtmlOutput('<h3>¡Autorizado Correctamente! Ya puedes regresar a tu aplicación web HTML y publicar directamente o programar.</h3>');
      }
    } catch (err) {
      return HtmlService.createHtmlOutput('Error obteniendo token: ' + err.toString());
    }
  }
  const scope = "w_member_social profile openid email";
  const authUrl = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(scope)}`;
  return HtmlService.createHtmlOutput(`
    <div style="font-family:sans-serif; text-align:center; padding:50px;">
      <h3>Conexión a tu cuenta de LinkedIn</h3>
      <a href="${authUrl}" target="_top" style="padding:15px 30px; background-color:#0077b5; color:white; text-decoration:none; border-radius:5px; font-weight:bold;">Conectar LinkedIn</a>
    </div>
  `);
}

// --- PASO 3: GESTIÓN DE PETICIONES (Híbrido Directo + Programado) ---
function doPost(e) {
  const token = props.getProperty('LINKEDIN_TOKEN');
  const urn = props.getProperty('LINKEDIN_URN');
  
  if (!token || !urn) {
    return jsonResponse({error: "Script no autorizado a LinkedIn. Entra a la URL de la web app."});
  }

  try {
    const data = JSON.parse(e.postData.contents);
    const action = data.action;

    // A. Lógica de Programador
    if (action === 'schedule') return saveToQueue(data);
    if (action === 'list') return listQueue();
    if (action === 'delete') return deleteFromQueue(data.id);

    // B. Lógica de Publicación Directa
    const imgBase64 = data.image_base64 || data.imageBase64;
    let imageBlob = null;
    if (imgBase64) {
      const bytes = Utilities.base64Decode(imgBase64.split(",")[1]);
      imageBlob = Utilities.newBlob(bytes, 'image/jpeg', 'post.jpg');
    }

    publishToLinkedInWithBlob(token, urn, data.text, imageBlob);
    return jsonResponse({success: true, details: "Publicado al instante"});

  } catch (err) {
    return jsonResponse({error: err.toString()});
  }
}

// --- LOGICA DE PROGRAMADOR EN DRIVE ---
function saveToQueue(data) {
  const folder = getOrCreateFolder();
  let imageFileId = null;
  const imgData = data.imageBase64 || data.image_base64;
  if (imgData) {
    const bytes = Utilities.base64Decode(imgData.split(",")[1]);
    const blob = Utilities.newBlob(bytes, "image/jpeg", `IMG_${data.id}.jpg`);
    const file = folder.createFile(blob);
    imageFileId = file.getId();
    delete data.imageBase64; delete data.image_base64;
    data.imageFileId = imageFileId;
  }
  folder.createFile(`POST_${data.id}.json`, JSON.stringify(data));
  return jsonResponse({success: true});
}

function listQueue() {
  const folder = getOrCreateFolder();
  const files = folder.getFiles();
  const posts = [];
  while (files.hasNext()) {
    const file = files.next();
    if (file.getName().endsWith('.json')) posts.push(JSON.parse(file.getContentText()));
  }
  return jsonResponse({success: true, posts: posts});
}

function deleteFromQueue(id) {
  const folder = getOrCreateFolder();
  const files = folder.getFilesByName(`POST_${id}.json`);
  while (files.hasNext()) {
    const f = files.next();
    const post = JSON.parse(f.getContentText());
    if (post.imageFileId) try { DriveApp.getFileById(post.imageFileId).setTrashed(true); } catch(e){}
    f.setTrashed(true);
  }
  return jsonResponse({success: true});
}

// --- EL "ROBOT" AUTOMÁTICO ---
function automaticSchedulerTask() {
  const token = props.getProperty('LINKEDIN_TOKEN');
  const urn = props.getProperty('LINKEDIN_URN');
  if (!token || !urn) return;

  const folder = getOrCreateFolder();
  const files = folder.getFiles();
  const now = new Date();

  while (files.hasNext()) {
    const file = files.next();
    if (!file.getName().endsWith('.json')) continue;
    
    const post = JSON.parse(file.getContentText());
    if (post.status !== 'pending') continue;

    const scheduledDate = new Date(`${post.date}T${post.time}:00`);
    if (now >= scheduledDate) {
      try {
        let imageBlob = post.imageFileId ? DriveApp.getFileById(post.imageFileId).getBlob() : null;
        publishToLinkedInWithBlob(token, urn, post.text, imageBlob);
        if (post.imageFileId) DriveApp.getFileById(post.imageFileId).setTrashed(true);
        file.setTrashed(true);
      } catch (e) {
        post.status = 'error';
        file.setContent(JSON.stringify(post));
      }
    }
  }
}

// --- FUNCIÓN DE SUBIDA A LINKEDIN ---
function publishToLinkedInWithBlob(token, urn, text, imageBlob) {
  let assetURN = null;
  if (imageBlob) {
    const registerPayload = {"registerUploadRequest": {"recipes": ["urn:li:digitalmediaRecipe:feedshare-image"],"owner": urn,"serviceRelationships": [{"relationshipType": "OWNER", "identifier": "urn:li:userGeneratedContent"}]}};
    const regRes = UrlFetchApp.fetch('https://api.linkedin.com/v2/assets?action=registerUpload', {method: 'post', headers: {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}, payload: JSON.stringify(registerPayload)});
    const uploadUrl = JSON.parse(regRes.getContentText()).value.uploadMechanism["com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"].uploadUrl;
    assetURN = JSON.parse(regRes.getContentText()).value.asset;
    UrlFetchApp.fetch(uploadUrl, {method: 'put', headers: {'Authorization': 'Bearer ' + token}, payload: imageBlob});
  }
  const postPayload = {"author": urn, "lifecycleState": "PUBLISHED", "specificContent": {"com.linkedin.ugc.ShareContent": {"shareCommentary": {"text": text}, "shareMediaCategory": assetURN ? "IMAGE" : "NONE", "media": assetURN ? [{"status": "READY", "media": assetURN, "title": {"text": "AI Content"}}] : []}}, "visibility": {"com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC"}};
  UrlFetchApp.fetch('https://api.linkedin.com/v2/ugcPosts', {method: 'post', headers: {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'X-Restli-Protocol-Version': '2.0.0'}, payload: JSON.stringify(postPayload)});
}

// UTILES
function getOrCreateFolder() {
  const folders = DriveApp.getFoldersByName(QUEUE_FOLDER_NAME);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(QUEUE_FOLDER_NAME);
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doOptions(e) {
  return ContentService.createTextOutput("").setMimeType(ContentService.MimeType.TEXT).setHeader("Access-Control-Allow-Origin", "*").setHeader("Access-Control-Allow-Methods", "POST, OPTIONS").setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function setupTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('automaticSchedulerTask').timeBased().everyMinutes(15).create();
}
