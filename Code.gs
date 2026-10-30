/**
 * Google Apps Script para receber códigos de suporte remoto
 * e gravá-los em uma planilha Google Sheets
 * 
 * Substitua o código no Editor do Apps Script e implante uma Nova Versão da Implantação da Web.
 */

const SHEET_ID = '1bH1MC8jU6D7oMsqDdZlWRJBLp6vcJlqey8hP_W89pBQ';
const SHEET_NAME = 'Sheet1';

// Recebe código enviado pela extensão via POST
function doPost(e) {
  try {
    const params = e.postData ? JSON.parse(e.postData.contents) : {};
    const code = (params.code || params.text || '').toString().trim();
    const timestamp = new Date().toISOString();
    
    if (!code) {
      return ContentService.createTextOutput(
        JSON.stringify({ success: false, error: 'Código não fornecido' })
      ).setMimeType(ContentService.MimeType.JSON);
    }
    
    // Acessar a planilha
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let sheet = ss.getSheetByName(SHEET_NAME);
    
    // Se a sheet não existir, criar
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAME);
      sheet.appendRow(['Codigo', 'Timestamp']);
    }
    
    // Garantir cabeçalho
    if (sheet.getLastRow() === 0 || sheet.getRange(1, 1).getValue() !== 'Codigo') {
      sheet.clear();
      sheet.appendRow(['Codigo', 'Timestamp']);
    }
    
    // Adicionar linha com código e timestamp
    sheet.appendRow([code, timestamp]);
    
    return ContentService.createTextOutput(
      JSON.stringify({ 
        success: true, 
        code: code,
        timestamp: timestamp,
        message: 'Código salvo com sucesso'
      })
    ).setMimeType(ContentService.MimeType.JSON);
    
  } catch (error) {
    console.error('Erro no GAS:', error);
    return ContentService.createTextOutput(
      JSON.stringify({ success: false, error: error.message })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

// Retorna os últimos códigos gravados via GET
function doGet(e) {
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let sheet = ss.getSheetByName(SHEET_NAME);
    
    if (!sheet) {
      return ContentService.createTextOutput(
        JSON.stringify({ success: true, codes: [] })
      ).setMimeType(ContentService.MimeType.JSON);
    }
    
    const data = sheet.getDataRange().getValues();
    const codes = [];
    
    for (let i = 1; i < data.length; i++) { // Pula cabeçalho
      if (data[i][0]) {
        codes.push({
          code: data[i][0],
          timestamp: data[i][1] || 'N/A'
        });
      }
    }
    
    return ContentService.createTextOutput(
      JSON.stringify({ success: true, codes: codes })
    ).setMimeType(ContentService.MimeType.JSON);
    
  } catch (error) {
    return ContentService.createTextOutput(
      JSON.stringify({ success: false, error: error.message })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

// Função para testar manualmente no editor
function testSaveCode() {
  const code = '1234 5678 9012';
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  
  if (sheet.getLastRow() === 0 || sheet.getRange(1, 1).getValue() !== 'Codigo') {
    sheet.appendRow(['Codigo', 'Timestamp']);
  }
  
  sheet.appendRow([code, new Date().toISOString()]);
  Logger.log('Código de teste salvo: ' + code);
}
