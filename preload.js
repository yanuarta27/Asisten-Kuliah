const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (channel) => (arg) => ipcRenderer.invoke(channel, arg);

contextBridge.exposeInMainWorld('api', {
  getSettings: call('settings:get'),
  pickRoot: call('settings:pickRoot'),
  addInboxDir: call('settings:addInbox'),
  removeInboxDir: call('settings:removeInbox'),
  getIcon: call('icon:get'),
  pickIcon: call('icon:pick'),
  resetIcon: call('icon:reset'),

  listCourses: call('courses:list'),
  createCourse: call('courses:create'),
  courseFiles: call('course:files'),

  readNote: call('notes:read'),
  writeNote: call('notes:write'),
  createNote: call('notes:create'),
  renameNote: call('notes:rename'),
  trashNote: call('notes:trash'),

  pickFiles: call('files:pick'),
  addFiles: call('files:add'),
  moveFile: call('files:move'),
  openPath: call('files:open'),
  revealPath: call('files:reveal'),
  trashPath: call('files:trash'),
  openRoot: call('root:open'),

  listInbox: call('inbox:list'),

  loadData: call('data:load'),
  saveData: call('data:save'),

  pathForFile: (file) => webUtils.getPathForFile(file),
  onChanged: (cb) => ipcRenderer.on('fs:changed', () => cb()),
});
