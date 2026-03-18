// ============================================================
//   LINKEDINMATIC — Google Apps Script Backend
//   Versión 2.0: OAuth + Publicación + Programador Automático
// ============================================================

const CLIENT_ID = 'TU_CLIENT_ID_AQUÍ';
const CLIENT_SECRET = 'TU_CLIENT_SECRET_AQUÍ';

// URL Script App (Reemplazar cuando se publique como Web App)
const REDIRECT_URI = ScriptApp.getService().getUrl();

// ID de la hoja de cálculo (extraer de la URL de tu Google Sheet)
const SHEET_ID = PropertiesService.getScriptProperties().getProperty('SHEET_ID') || 'TU_SHEET_ID_AQUI';

// Nombre de la pestaña donde se guardan los posts programados
const SCHEDULED_SHEET_NAME = 'Cola_Programada';


// ============================================================
//  SECCIÓN 1: OAUTH LINKEDIN
// ============================================================

function doGet(e) {
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
        PropertiesService.getScriptProperties().setProperty('LINKEDIN_TOKEN', data.access_token);

        const profileResponse = UrlFetchApp.fetch('https://api.linkedin.com/v2/userinfo', {
          headers: { 'Authorization': 'Bearer ' + data.access_token }
        });
        const profileData = JSON.parse(profileResponse.getContentText());
        PropertiesService.getScriptProperties().setProperty('LINKEDIN_URN', 'urn:li:person:' + profileData.sub);

        return HtmlService.createHtmlOutput('<h3>¡Autorizado Correctamente! Ya puedes regresar a tu aplicación.</h3>');
      }
    } catch (err) {
      return HtmlService.createHtmlOutput('Error obteniendo token: ' + err.toString());
    }
  }

  const scope = "w_member_social profile openid email";
  const authUrl = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(scope)}`;

  return HtmlService.createHtmlOutput(`
    <h3>Conexión a tu cuenta de LinkedIn</h3>
    <a href="${authUrl}" target="_top" style="padding:10px 20px; background-color:#0077b5; color:white; text-decoration:none; border-radius:5px;">Conectar LinkedIn</a>
  `);
}


// ============================================================
//  SECCIÓN 2: PUBLICACIÓN INMEDIATA (doPost original)
// ============================================================

function doPost(e) {
  const data = JSON.parse(e.postData.contents);
  const action = data.action || 'publish';

  // --- Enrutar según la acción ---
  if (action === 'saveScheduled') {
    return handleSaveScheduled(data);
  } else if (action === 'getScheduled') {
    return handleGetScheduled();
  } else if (action === 'deleteScheduled') {
    return handleDeleteScheduled(data.id);
  } else {
    return handlePublishNow(data);
  }
}

/**
 * Publica un post INMEDIATAMENTE en LinkedIn con imagen.
 */
function handlePublishNow(data) {
  const token = PropertiesService.getScriptProperties().getProperty('LINKEDIN_TOKEN');
  const urn = PropertiesService.getScriptProperties().getProperty('LINKEDIN_URN');

  if (!token || !urn) {
    return jsonResponse({ error: "Script no autorizado a LinkedIn." });
  }

  try {
    return jsonResponse(publishToLinkedIn(token, urn, data.text, data.imageUrl || null, data.image_base64 || null));
  } catch (err) {
    return jsonResponse({ error: err.toString() });
  }
}


// ============================================================
//  SECCIÓN 3: PROGRAMADOR — GUARDAR EN GOOGLE SHEET
// ============================================================

/**
 * Recibe un post programado desde el frontend y lo guarda en la hoja.
 */
function handleSaveScheduled(data) {
  try {
    const sheet = getOrCreateScheduledSheet();
    const now = new Date();

    sheet.appendRow([
      data.id,                          // Col A: ID único
      data.text,                        // Col B: Texto del post
      data.imageUrl || '',              // Col C: URL imagen (Pollinations)
      data.style || '',                 // Col D: Estilo visual
      data.intention || '',             // Col E: Intención
      data.row || '',                   // Col F: Fila en BD principal
      data.date,                        // Col G: Fecha programada (YYYY-MM-DD)
      data.time,                        // Col H: Hora programada (HH:MM)
      'pending',                        // Col I: Estado
      now.toISOString()                 // Col J: Fecha de creación
    ]);

    return jsonResponse({ success: true, message: 'Post guardado en la cola.' });
  } catch (err) {
    return jsonResponse({ error: err.toString() });
  }
}

/**
 * Devuelve todos los posts de la cola (pending + published).
 */
function handleGetScheduled() {
  try {
    const sheet = getOrCreateScheduledSheet();
    const rows = sheet.getDataRange().getValues();
    const posts = [];

    // Saltar la primera fila si es cabecera
    const startRow = rows[0][0] === 'id' ? 1 : 0;

    for (let i = startRow; i < rows.length; i++) {
      const r = rows[i];
      if (!r[0]) continue; // Fila vacía
      posts.push({
        id: r[0],
        text: r[1],
        imageUrl: r[2],
        style: r[3],
        intention: r[4],
        rowBD: r[5],
        date: r[6],
        time: r[7],
        status: r[8],
        createdAt: r[9]
      });
    }

    return jsonResponse({ success: true, posts: posts });
  } catch (err) {
    return jsonResponse({ error: err.toString() });
  }
}

/**
 * Elimina un post programado por su ID.
 */
function handleDeleteScheduled(id) {
  try {
    const sheet = getOrCreateScheduledSheet();
    const data = sheet.getDataRange().getValues();

    for (let i = data.length - 1; i >= 0; i--) {
      if (String(data[i][0]) === String(id)) {
        sheet.deleteRow(i + 1);
        return jsonResponse({ success: true, message: 'Post eliminado.' });
      }
    }

    return jsonResponse({ error: 'Post no encontrado.' });
  } catch (err) {
    return jsonResponse({ error: err.toString() });
  }
}


// ============================================================
//  SECCIÓN 4: TRIGGER AUTOMÁTICO — Publicar posts pendientes
// ============================================================

/**
 * Esta función se ejecuta automáticamente cada 5 minutos via trigger de tiempo.
 * Comprueba la cola y publica los posts cuya fecha/hora ya ha llegado.
 *
 * INSTRUCCIONES PARA CONFIGURAR EL TRIGGER:
 * 1. Abre este script en Google Apps Script
 * 2. Ve a "Triggers" (reloj en el menú izquierdo)
 * 3. Crea un nuevo trigger: función = checkScheduledPosts, evento = basado en tiempo, cada 5 minutos
 */
function checkScheduledPosts() {
  const token = PropertiesService.getScriptProperties().getProperty('LINKEDIN_TOKEN');
  const urn = PropertiesService.getScriptProperties().getProperty('LINKEDIN_URN');

  if (!token || !urn) {
    Logger.log('SCHEDULER: No hay token de LinkedIn. Abortando.');
    return;
  }

  const sheet = getOrCreateScheduledSheet();
  const data = sheet.getDataRange().getValues();
  const now = new Date();

  Logger.log('SCHEDULER: Revisando cola a las ' + now.toISOString());

  const startRow = data[0][0] === 'id' ? 1 : 0;

  for (let i = startRow; i < data.length; i++) {
    const row = data[i];
    const id = row[0];
    const text = row[1];
    const imageUrl = row[2];
    const status = row[8];

    if (!id || status !== 'pending') continue;

    // Construir la fecha/hora programada
    const scheduledDate = row[6]; // YYYY-MM-DD
    const scheduledTime = row[7]; // HH:MM

    if (!scheduledDate || !scheduledTime) continue;

    const scheduledStr = `${scheduledDate}T${scheduledTime}:00`;
    const scheduledDateTime = new Date(scheduledStr);

    // Si ya pasó la hora programada → publicar
    if (now >= scheduledDateTime) {
      Logger.log(`SCHEDULER: Publicando post ID=${id} programado para ${scheduledStr}`);

      try {
        const result = publishToLinkedIn(token, urn, text, imageUrl, null);

        if (result.success) {
          // Marcar como publicado en la hoja
          sheet.getRange(i + 1, 9).setValue('published');
          sheet.getRange(i + 1, 10).setValue(new Date().toISOString());
          Logger.log(`SCHEDULER: ✅ Post ID=${id} publicado correctamente.`);
        } else {
          // Marcar como error
          sheet.getRange(i + 1, 9).setValue('error: ' + (result.error || 'desconocido'));
          Logger.log(`SCHEDULER: ❌ Error en post ID=${id}: ${result.error}`);
        }

      } catch (err) {
        sheet.getRange(i + 1, 9).setValue('error: ' + err.toString());
        Logger.log(`SCHEDULER: ❌ Excepción en post ID=${id}: ${err.toString()}`);
      }

      // Esperar un poco entre publicaciones para no saturar la API
      Utilities.sleep(2000);
    }
  }
}

/**
 * Instala el trigger automático de 5 minutos.
 * Ejecutar esta función UNA VEZ manualmente desde el editor de Apps Script.
 */
function installSchedulerTrigger() {
  // Verificar que no exista ya el trigger para evitar duplicados
  const existing = ScriptApp.getProjectTriggers();
  for (const t of existing) {
    if (t.getHandlerFunction() === 'checkScheduledPosts') {
      Logger.log('El trigger ya existe. No se crea uno nuevo.');
      return;
    }
  }

  ScriptApp.newTrigger('checkScheduledPosts')
    .timeBased()
    .everyMinutes(5)
    .create();

  Logger.log('✅ Trigger instalado: checkScheduledPosts cada 5 minutos.');
}

/**
 * Elimina el trigger del programador (si necesitas desactivarlo).
 */
function uninstallSchedulerTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const t of triggers) {
    if (t.getHandlerFunction() === 'checkScheduledPosts') {
      ScriptApp.deleteTrigger(t);
      Logger.log('Trigger eliminado.');
    }
  }
}


// ============================================================
//  SECCIÓN 5: UTILIDADES COMPARTIDAS
// ============================================================

/**
 * Publica un post en LinkedIn con o sin imagen.
 * @param {string} token - Access token OAuth
 * @param {string} urn - URN del autor
 * @param {string} text - Texto del post
 * @param {string|null} imageUrl - URL pública de la imagen (Pollinations / Cloudinary)
 * @param {string|null} base64Image - Imagen en base64 "data:image/jpeg;base64,..."
 */
function publishToLinkedIn(token, urn, text, imageUrl, base64Image) {
  let assetURN = null;

  // --- Si hay imagen, subirla a LinkedIn ---
  if (imageUrl || base64Image) {
    // Registrar el upload
    const registerPayload = {
      "registerUploadRequest": {
        "recipes": ["urn:li:digitalmediaRecipe:feedshare-image"],
        "owner": urn,
        "serviceRelationships": [{ "relationshipType": "OWNER", "identifier": "urn:li:userGeneratedContent" }]
      }
    };

    const registerRes = UrlFetchApp.fetch('https://api.linkedin.com/v2/assets?action=registerUpload', {
      method: 'post',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      payload: JSON.stringify(registerPayload)
    });
    const registerData = JSON.parse(registerRes.getContentText());
    const uploadUrl = registerData.value.uploadMechanism["com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"].uploadUrl;
    assetURN = registerData.value.asset;

    // Preparar el blob de imagen
    let imageBlob;
    if (base64Image) {
      const base64Data = base64Image.split(',')[1];
      imageBlob = Utilities.newBlob(Utilities.base64Decode(base64Data), 'image/jpeg', 'post.jpg');
    } else {
      // Descargar desde URL pública
      const imgResponse = UrlFetchApp.fetch(imageUrl);
      imageBlob = imgResponse.getBlob().setName('post.jpg');
    }

    // Subir la imagen
    UrlFetchApp.fetch(uploadUrl, {
      method: 'put',
      headers: { 'Authorization': 'Bearer ' + token },
      payload: imageBlob
    });
  }

  // --- Costruir el payload del post ---
  let postPayload;

  if (assetURN) {
    postPayload = {
      "author": urn,
      "lifecycleState": "PUBLISHED",
      "specificContent": {
        "com.linkedin.ugc.ShareContent": {
          "shareCommentary": { "text": text },
          "shareMediaCategory": "IMAGE",
          "media": [{
            "status": "READY",
            "media": assetURN,
            "title": { "text": "Generado con IA" }
          }]
        }
      },
      "visibility": { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" }
    };
  } else {
    // Post solo de texto
    postPayload = {
      "author": urn,
      "lifecycleState": "PUBLISHED",
      "specificContent": {
        "com.linkedin.ugc.ShareContent": {
          "shareCommentary": { "text": text },
          "shareMediaCategory": "NONE"
        }
      },
      "visibility": { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" }
    };
  }

  const uploadPostRes = UrlFetchApp.fetch('https://api.linkedin.com/v2/ugcPosts', {
    method: 'post',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0'
    },
    payload: JSON.stringify(postPayload)
  });

  return { success: true, result: uploadPostRes.getContentText() };
}

/**
 * Obtiene (o crea si no existe) la hoja "Cola_Programada".
 */
function getOrCreateScheduledSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(SCHEDULED_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(SCHEDULED_SHEET_NAME);
    // Crear cabecera
    sheet.appendRow(['id', 'text', 'imageUrl', 'style', 'intention', 'rowBD', 'date', 'time', 'status', 'timestamp']);
    sheet.getRange(1, 1, 1, 10).setFontWeight('bold');
    Logger.log('Hoja "Cola_Programada" creada.');
  }

  return sheet;
}

/**
 * Helper para devolver respuestas JSON con CORS.
 */
function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Configurar CORS preflight
function doOptions(e) {
  return ContentService.createTextOutput("")
    .setMimeType(ContentService.MimeType.TEXT)
    .setHeader("Access-Control-Allow-Origin", "*")
    .setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
    .setHeader("Access-Control-Allow-Headers", "Content-Type");
}
