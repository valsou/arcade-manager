const fs = require('fs-extra');
const path = require('path');
const http = require('http');
const https = require('https');
const events = require('events');
const settings = require('electron-settings');

const Downloader = require('./downloader.js');
const downloader = new Downloader();

const data = require('./data.json');

let mustCancel = false; // cancellation token
let nbOverlays = 0; // number of installed overlays
let total = 0; // total number of processed items
let current = 0; // current item number

module.exports = class Overlays extends events {
    /**
     * Asks the class to cancel the next action
     */
    cancel() {
        mustCancel = true;
    }

    /**
     * Checks that the program can access the specified folder
     * 
     * @param {string} folder The folder to check for access
     * @param {string} checkWrite Whether to check for write access
     * @returns {bool} Whether the check is successful
     */
    checkAccess (folder, checkWrite) {
        try {
            fs.ensureDirSync(folder);
        } catch (err) {
            console.error('The folder %s does not exist or cannot be read, and cannot be created!', folder);
            console.log('Exiting...');
            return false;
        }
        
        if (fs.existsSync(folder)) {
            if (checkWrite) {
                var testFile = path.join(folder, '_test-install.txt');
                try {
                    fs.writeFileSync(testFile, 'test');
                    if (fs.existsSync(testFile)) {
                        fs.unlinkSync(testFile);
                    } else {
                        console.error('Unable to write files into the folder %s!', folder);
                        console.log('Exiting...');
                        return false;
                    }
                } catch (err) {
                    console.error('Unable to write files into the folder %s: %o', folder, err);
                    console.log('Exiting...');
                    return false;
                }
    
                console.log('%s can be written to', folder);
            } else {
                console.log('%s can be read', folder);
            }
        } else {
            console.error('The folder %s does not exist or cannot be read!', folder);
            console.log('Exiting...');
            return false;
        }

        return true;
    }

    /**
     * Fixes the paths in the specified file content
     * 
     * @param {object} base The base paths (ex: { retropie: /etc/, recalbox: /etc/ })
     * @param {string} content The file content to fix
     */
    fixPath(base, content) {
        let fromOs = settings.get('os') === 'retropie' ? 'recalbox' : 'retropie';
        let toOs = settings.get('os');
        return content.replace(new RegExp(base[fromOs], 'gm'), base[toOs]);
    }

    /**
     * Lists the files in the specified folder
     * 
     * @param {any} repository The repository
     * @param {any} folder The folder to list the files from
     * @returns {Promise} A promise listing the files in the folder
     */
    listFiles(repository, folder) {
        return new Promise((resolve, reject) => {
            downloader.listFiles(repository, folder, (files) => {
                if (mustCancel) { resolve(); return; }
                
                resolve(files);
            });
        });
    }

    /**
     * Downloads the common items
     * 
     * @param {String} repository The repository
     * @param {Object} common The common elements
     * @param {String} destPath The destination folder
     * @param {Boolean} overwrite Whether to overwrite existing files
     * @param {Object} base The base paths (ex: { retropie: /etc/, recalbox: /etc/ })
     * @returns {Promise} A promise downloading the items in the common folder
     */
    downloadCommon(repository, common, destPath, overwrite, base) {
        return new Promise((resolve, reject) => {
            if (mustCancel) { reject(); return; }

            if (typeof common !== 'undefined' && common) {
                total++;
                console.log('Installing common files');
                this.emit('progress.download', total, current++, 'common files');

                // only download if target folder does not exist
                if (overwrite || !fs.existsSync(destPath)) {
                    downloader.downloadFolder(repository, common.src, destPath, overwrite, (content) => {
                        return this.fixPath(base, content);
                    });
                }
            }
            
            resolve();
        });
    }

    /**
     * Gets the list of folders containing the specified file
     * 
     * @param {String} folders The folders to search
     * @param {String} file The file to look for
     */
    getFoldersContaining(folders, file) {
        return new Promise((resolve, reject) => {
            let result = [];
            for (let folder of folders) {
                if (fs.existsSync(path.join(folder, file))) {
                    result.push(folder);
                }
            }

            resolve(result);
        });
    }

    /**
     * Downloads the specified rom config
     * 
     * @param {String} repository The repository
     * @param {String} sourcePath The source path to the rom config to download
     * @param {String} destPath The path to save the rom configs to, if any
     * @param {Array} folders The list of folders where to download the config to
     * @param {Boolean} overwrite Whether to overwrite existing files
     * @param {Object} base The base paths
     * @returns {Promise} A promise that downloads the rom config
     */
    downloadRomConfig(repository, sourcePath, destPath, folders, overwrite, base) {
        return new Promise((resolveConfig, reject) => {
            let cfg = path.basename(sourcePath);
            let zip = cfg.replace('.cfg', '');

            let romConfigContent = '';

            this.getFoldersContaining(folders, zip)
            .then((romFolders) => {
                let foldersPromises = folders.reduce((promisechain, folder, index) => {
                    return promisechain.then(() => new Promise((resolve, reject) => {
                        let localromcfg = path.join(destPath ? destPath : folder, cfg);
                        if (fs.existsSync(path.join(folder, zip))) {
                            // corresponding zip file exists
                            console.log('Installing overlay for %s', zip);

                            if (!overwrite && fs.existsSync(localromcfg)) {
                                // rom cfg already exists
                                fs.readFile(localromcfg, { 'encoding': 'utf8' }, (err, romcfgContent) => {
                                    if (err) throw err;
                                    if (mustCancel) { resolve(); return; }

                                    romConfigContent = romcfgContent;
                                    resolve();
                                });
                            } else {
                                // download rom cfg
                                downloader.downloadFile(repository, sourcePath, (romcfgContent) => {
                                    if (mustCancel) { resolve(); return; }

                                    romcfgContent = this.fixPath(base, romcfgContent);
                                    fs.ensureDirSync(path.dirname(localromcfg));
                                    fs.writeFile(localromcfg, romcfgContent, (err) => {
                                        if (err && err.code !== 'EEXIST') throw err;
                                        if (mustCancel) { resolve(); return; }

                                        romConfigContent = romcfgContent;
                                        resolve();
                                    });
                                });
                            }
                        } else {
                            // the corresponding zip file does not exist
                            resolve('');
                        }
                    }));
                }, Promise.resolve());

                // execute promises
                foldersPromises
                .then(() => {
                    resolveConfig(romConfigContent);
                });
            });
        });
    }

    /**
     * Downloads the specified overlay config file to the specified location
     * 
     * @param {String} repository The repository
     * @param {String} sourcePath The source path to the overlay config to download
     * @param {String} destPath The path to the file to write to
     * @param {Boolean} overwrite Whether to overwrite existing files
     * @param {Object} base The base paths
     * @returns {Promise} A promise that downloads the overlay config
     */
    downloadOverlay(repository, sourcePath, destPath, overwrite, base) {
        return new Promise((resolve, reject) => {
            if (!overwrite && fs.existsSync(destPath)) {
                // overlay cfg already exists
                fs.readFile(destPath, { 'encoding': 'utf8'}, (err, overlayFileContent) => {
                    if (err) throw err;
                    if (mustCancel) { resolve(); return; }

                    resolve(overlayFileContent);
                });
            } else {
                // download overlay cfg
                downloader.downloadFile(repository, sourcePath, (packOverlayFileContent) => {
                    if (mustCancel) { resolve(); return; }
                    packOverlayFileContent = this.fixPath(base, packOverlayFileContent);
                    fs.ensureDirSync(path.dirname(destPath));
                    fs.writeFile(destPath, packOverlayFileContent, (err) => {
                        if (err) throw err;
                        if (mustCancel) { resolve(); return; }

                        resolve(packOverlayFileContent);
                    });
                });
            }
        });
    }

    /**
     * Downloads the specified image file to the specified location
     * 
     * @param {String} repository The repository
     * @param {String} sourcePath The source path to the overlay image to download
     * @param {String} destPath The path to the file to write to
     * @param {Boolean} overwrite Whether to overwrite existing files
     * @returns {Promise} A promise that downloads the overlay image
     */
    downloadOverlayImage(repository, sourcePath, destPath, overwrite) {
        return new Promise((resolve, reject) => {
            if (!overwrite && fs.existsSync(destPath)) {
                // image already exists
                resolve();
            } else {
                // download image
                downloader.downloadFile(repository, sourcePath, (imageContent) => {
                    if (mustCancel) { resolve(); return; }

                    fs.writeFile(destPath, imageContent, (err) => {
                        if (err) throw err;
                        nbOverlays++;
                        resolve();
                    });
                });
            }
        });
    }

    /**
     * Downloads and installs an overlay pack
     * 
     * @param {Array} romFolders The rom folders to install the overlays for
     * @param {String} configShare The path to the config share
     * @param {Object} packInfos The chosen pack informations
     * @param {Boolean} overwrite Whether to overwrite existing files
     */
    downloadPack (romFolders, configShare, packInfos, overwrite) {
        mustCancel = false;
        nbOverlays = 0;

        let repository = packInfos.repository,
            roms = packInfos.roms,
            overlays = packInfos.overlays,
            common = packInfos.common,
            base = packInfos.base;

        const os = settings.get('os');

        // check if the destination of rom cfg is the rom folder
        const romCfgFolder = packInfos.roms.dest[os] === 'roms'
            ? null // save rom cfg directly into rom folder(s)
            : path.join(configShare, packInfos.roms.dest[os]); // save rom cfg in config folder

        this.emit('start.download');
        this.emit('progress.download', 100, 1, 'files list');

        this.downloadCommon(repository, common, common ? path.join(configShare, common.dest[os]) : '', overwrite, base)
        .then(() => {
            return this.listFiles(repository, roms.src)
        })
        .then((romConfigs) => {
            total = romConfigs.length;
            current = 1;

            // loop on each config file
            let requests = romConfigs.reduce((promisechain, romcfg, index) => {
                return promisechain.then(() => new Promise((resolve, reject) => {
                    if (mustCancel) { resolve(); return; }

                    this.emit('progress.download', total, current++, romcfg.name);
    
                    // only process config files
                    if (romcfg.type !== 'file' || !romcfg.name.endsWith('.zip.cfg')) { 
                        resolve();
                        return;
                    }
    
                    // download rom config
                    this.downloadRomConfig(repository, romcfg.path, romCfgFolder, romFolders, overwrite, base)
                    .then((romcfgContent) => {
                        if (!romcfgContent || romcfgContent === '') { return Promise.resolve(''); }

                        // parse rom cfg to get overlay cfg
                        let overlayFile = /input_overlay[\s]*=[\s]*"?(.*\.cfg)"?/igm.exec(romcfgContent)[1]; // extract overlay path
                        overlayFile = overlayFile.substring(overlayFile.lastIndexOf('/')); // just the file name
                        let packOverlayFile = path.join(overlays.src, overlayFile); // concatenate with pack path                          
                        let localoverlaycfg = path.join(configShare, overlays.dest[os], overlayFile);

                        // download overlay config
                        return this.downloadOverlay(repository, packOverlayFile, localoverlaycfg, overwrite, base);
                    })
                    .then((overlayCfgContent) => {
                        if (!overlayCfgContent || overlayCfgContent === '') { return Promise.resolve(); }

                        // parse overlay cfg to get overlay image
                        let packOverlayImage = /overlay0_overlay[\s]*=[\s]*"?(.*\.png)"?/igm.exec(overlayCfgContent)[1];
                        let packOverlayImageFile = path.join(overlays.src, packOverlayImage);
                        let localoverlayimg = path.join(configShare, overlays.dest[os], packOverlayImage);

                        // download overlay image
                        return this.downloadOverlayImage(repository, packOverlayImageFile, localoverlayimg, overwrite);
                    })
                    .then(() => {
                        resolve();
                    });
                }));
            }, Promise.resolve());

            return requests;
        })
        .then(() => {
            this.emit('log', 'Installed ' + nbOverlays + ' overlays');
            this.emit('end.download', mustCancel);
        });
    }
};