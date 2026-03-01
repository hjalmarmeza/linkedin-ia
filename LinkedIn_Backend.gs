const CLIENT_ID = 'TU_CLIENT_ID_AQUÍ';
const CLIENT_SECRET = 'TU_CLIENT_SECRET_AQUÍ';

// URL Script App (Debe ser reemplazada cuando se publique como Web App)
const REDIRECT_URI = ScriptApp.getService().getUrl(); 

function doGet(e) {
  if (e.parameter.code) {
    // Paso 2: Intercambiar código por Token
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
        PropertiesService.getScriptProperties().setProperty('LINKEDIN_TOKEN', data.access_token);
        
        // Obtener el ID de Autor (URN)
        const profileResponse = UrlFetchApp.fetch('https://api.linkedin.com/v2/userinfo', {
          headers: { 'Authorization': 'Bearer ' + data.access_token }
        });
        const profileData = JSON.parse(profileResponse.getContentText());
        PropertiesService.getScriptProperties().setProperty('LINKEDIN_URN', 'urn:li:person:' + profileData.sub);
        
        return HtmlService.createHtmlOutput('<h3>¡Autorizado Correctamente! Ya puedes regresar a tu aplicación web HTML y publicar directamente.</h3>');
      }
    } catch (err) {
      return HtmlService.createHtmlOutput('Error obteniendo token: ' + err.toString());
    }
  }
  
  // Paso 1: Redirigir a Pantalla de Login de LinkedIn
  const scope = "w_member_social profile openid email";
  const authUrl = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(scope)}`;
  
  return HtmlService.createHtmlOutput(`
    <h3>Conexión a tu cuenta de LinkedIn</h3>
    <a href="${authUrl}" target="_top" style="padding:10px 20px; background-color:#0077b5; color:white; text-decoration:none; border-radius:5px;">Conectar LinkedIn</a>
  `);
}

function doPost(e) {
  const token = PropertiesService.getScriptProperties().getProperty('LINKEDIN_TOKEN');
  const urn = PropertiesService.getScriptProperties().getProperty('LINKEDIN_URN');
  
  if (!token || !urn) {
    return ContentService.createTextOutput(JSON.stringify({error: "Script no autorizado a LinkedIn. Entra a la URL de la web app."})).setMimeType(ContentService.MimeType.JSON);
  }
  
  try {
    const data = JSON.parse(e.postData.contents);
    const text = data.text;
    const base64Image = data.image_base64; // "data:image/jpeg;base64,..."
    
    // 1. Decodificar la imagen Base64
    const base64Data = base64Image.split(',')[1];
    const imageBlob = Utilities.newBlob(Utilities.base64Decode(base64Data), 'image/jpeg', 'post.jpg');
    
    // 2. Registrar el Upload en LinkedIn
    const registerPayload = {
      "registerUploadRequest": {
        "recipes": ["urn:li:digitalmediaRecipe:feedshare-image"],
        "owner": urn,
        "serviceRelationships": [{"relationshipType": "OWNER", "identifier": "urn:li:userGeneratedContent"}]
      }
    };
    
    const registerRes = UrlFetchApp.fetch('https://api.linkedin.com/v2/assets?action=registerUpload', {
      method: 'post',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      payload: JSON.stringify(registerPayload)
    });
    const registerData = JSON.parse(registerRes.getContentText());
    
    const uploadUrl = registerData.value.uploadMechanism["com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"].uploadUrl;
    const assetURN = registerData.value.asset;
    
    // 3. Subir el Blob de la imagen a LinkedIn
    UrlFetchApp.fetch(uploadUrl, {
      method: 'put',
      headers: { 'Authorization': 'Bearer ' + token },
      payload: imageBlob
    });
    
    // 4. Crear el Post Final (UGC Post)
    const postPayload = {
      "author": urn,
      "lifecycleState": "PUBLISHED",
      "specificContent": {
        "com.linkedin.ugc.ShareContent": {
          "shareCommentary": { "text": text },
          "shareMediaCategory": "IMAGE",
          "media": [
            {
              "status": "READY",
              "media": assetURN,
              "title": { "text": "Generado con IA" }
            }
          ]
        }
      },
      "visibility": { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" }
    };
    
    const uploadPostRes = UrlFetchApp.fetch('https://api.linkedin.com/v2/ugcPosts', {
      method: 'post',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0'
      },
      payload: JSON.stringify(postPayload)
    });
    
    return ContentService.createTextOutput(JSON.stringify({success: true, result: uploadPostRes.getContentText()}))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({error: err.toString()})).setMimeType(ContentService.MimeType.JSON);
  }
}

// Configurar CORS
function doOptions(e) {
  return ContentService.createTextOutput("")
    .setMimeType(ContentService.MimeType.TEXT)
    .setHeader("Access-Control-Allow-Origin", "*")
    .setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
    .setHeader("Access-Control-Allow-Headers", "Content-Type");
}
