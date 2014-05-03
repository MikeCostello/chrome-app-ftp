/*
Copyright 2013 Michael Costello.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

     http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

Author: Michael Costello (michael.a.costello@gmail.com)
*/

(function(exports) {
  /**
   * Creates an instance of the client
   *
   * @param {String} host The remote host to connect to
   * @param {Number} port The port to connect to at the remote host
   * @param {String} user The user account to connect with
   * @param {String} password The password to connect with
  */
  function FtpClient(host, port, user, password) {
    this.host = host;
    this.port = port;
    this.username = user;
    this.password = password;
    this.isConnected = false;
    this.features = {};

    log('initialized ftp client');
  }

  /**
   * Makes initial connection to ftp server.
   * The control socket is used to send ftp commands.
   */
  FtpClient.prototype.connect = function() {
    var deferred = Q.defer();

    this.controlSocket = new TcpClient(this.host, this.port);
    this.controlSocket.connect(function() {
      this._user(this.username)
        .then(this._pass.bind(this, this.password))
        .then(this._feat.bind(this))
        .then(this._type.bind(this, "I"))
        .then(function() {
          this.isConnected = true;
          this.keepAlive = setInterval(this._noop.bind(this), 500000); // 500s

          deferred.resolve(this);
        }.bind(this));
    }.bind(this));

    return deferred.promise;
  };

  /**
   * Terminates connection to ftp server
   */
  FtpClient.prototype.disconnect = function() {
    var deferred = Q.defer();

    this._quit()
      .then(function() {
        clearInterval(this.keepAlive);

        this.controlSocket.disconnect();
        this.controlSocket = null;
        this.isConnected = false;

        deferred.resolve(this);
      }.bind(this));

    return deferred.promise;
  };

  /**
   * Returns an array of directory contents
   *
   * @param {String} optional path of directory to list. If omitted the current directory is used.
   */
  FtpClient.prototype.list = function(pathname) {
    var deferred = Q.defer();
    var listCmd, listParse;

    if (this.features.mlst) {
      listCmd = "_mlsd";
      listParse = "_parseMlsd";
    } else {
      listCmd = "_list";
      listParse = "_parseList";
    }

    if (typeof pathname !== "string") {
      pathname = ".";
    }

    function onSuccess(list) {
      deferred.resolve(this[listParse](list));
    }

    this._pasv()
      .then(this._createDataSocket.bind(this, onSuccess.bind(this)))
      .then(this[listCmd].bind(this, pathname));

    return deferred.promise;
  };

  /**
   * Returns an ArrayBuffer of the downloaded file
   *
   * @param {String} pathname of the file to download
   */
  FtpClient.prototype.download = function(pathname) {
    var deferred = Q.defer();

    function onSuccess(buffer) {
      deferred.resolve(buffer);
    }

    this._pasv()
      .then(this._createDataSocket.bind(this, onSuccess, false))
      .then(this._retr.bind(this, pathname));

    return deferred.promise;
  };

  /**
   * Uploads an ArrayBuffer to the ftp server
   *
   * @param {String} path on the server to write the file to
   * @param {ArrayBuffer} data to send the server
   */
  FtpClient.prototype.upload = function(pathname, buffer) {
    var deferred = Q.defer();
    var isText = typeof buffer === "string";
    var sockets = {};

    this._pasv()
      .then(this._createDataSocket.bind(this, null, isText))
      .then(function(dataSocket) {
        this.dataSocket = dataSocket;
      }.bind(sockets))
      .then(this._stor.bind(this, pathname))
      .then(function(sockets) {
        var dataSocket = sockets.dataSocket;

        this.controlSocket.addResponseListener(function(data) {
          log(data);
          deferred.resolve();
        });

        dataSocket.sendMessage(buffer, function(resp) {
          log("onDataWrite: " + resp.bytesWritten);
          clearInterval(dataSocket.readTimer);
          dataSocket.disconnect();
          dataSocket = null;
        });
      }.bind(this, sockets));

    return deferred.promise;
  };

  /**
   * Renames a file on the server
   *
   * @param {String} old pathname on the server
   * @param {String} new pathname on the server
   */
  FtpClient.prototype.rename = function(from, to) {
    var deferred = Q.defer();

    this._rnfr(from)
      .then(this._rnto.bind(this, to))
      .then(deferred.resolve);

    return deferred.promise;
  };

  /**
   * Creates a separate socket for data, in parallel with the control socket.
   *
   * @private
   * @param {Function} called after the socket has completed transfering
   * @param {Boolean} optionally sets if data should be sent/recv as a String
   * @param {Number} port The port to connect to at the remote host
   */
  FtpClient.prototype._createDataSocket = function(callback, isText, port) {
    port = Array.prototype.pop.call(arguments);

    var deferred = Q.defer();
    var dataSocket = new TcpClient(this.host, port);
    var resp = "";
    var noDataTimer, readTimer;

    isText = isText !== false;

    // Overlaod TcpClient to keep data as ArrayBuffer
    if (!isText) {
      dataSocket._onDataRead = function(readInfo) {
        if (readInfo.resultCode > 0 && this.callbacks.recv) {
          log('onDataRead: ' + readInfo.data.byteLength);
          this.callbacks.recv(readInfo.data);
        }
      };

      // Overlaod TcpClient to keep data as ArrayBuffer
      dataSocket.sendMessage = function(arrayBuffer, callback) {
        chrome.socket.write(this.socketId, arrayBuffer, this._onWriteComplete.bind(this));

        this.callbacks.sent = callback;
      };
    }

    // Set a shorter interval to check for data
    dataSocket.readTimer = setInterval(dataSocket._periodicallyRead.bind(dataSocket), 10);

    dataSocket.connect(function() {
      dataSocket.addResponseListener(function(data) {
        if (!isText) {
          if (resp !== "") {
            resp = this._arrayBufferConcat(resp, data);
          } else {
            resp = data;
          }
        } else {
          resp += data;
        }

        // Resolve 500ms after no data is received
        clearTimeout(noDataTimer);
        noDataTimer = setTimeout(function() {
          clearInterval(dataSocket.readTimer);
          dataSocket.disconnect();
          dataSocket = null;

          if (typeof callback === "function") {
            callback(resp);
          }
        }, 500);
      }.bind(this));

      deferred.resolve(dataSocket);
    }.bind(this));

    return deferred.promise;
  };

  /**
   * Returns a concatinated ArrayBuffer from two buffers.
   *
   * @private
   * @param {ArrayBuffer} first buffer
   * @param {ArrayBuffer} second buffer
   */
  FtpClient.prototype._arrayBufferConcat = function(buf1, buf2) {
    var bufView = new Uint8Array(buf1.byteLength + buf2.byteLength);

    bufView.set(new Uint8Array(buf1), 0);
    bufView.set(new Uint8Array(buf2), buf1.byteLength);

    return bufView.buffer;
  };

  /**
   * Sends ftp commands over the control socket
   *
   * @private
   * @param {String} ftp command to send
   * @param {Number} status code that when matches the server responce code, the callback is called
   * @param {Function} called if the success code matches the server responce code
   */
  FtpClient.prototype._controlCommand = function(cmd, successCode, callback) {
    if (this.controlSocket) {
      var controlSocket = this.controlSocket;

      controlSocket.addResponseListener(function(data) {
        var code = this._responseToCode(data);

        log(data);

        if (code === successCode) {
          callback.call(this, data);
        }
      }.bind(this));

      controlSocket.sendMessage(cmd);
    }
  };

  /**
   *
   * FTP Control Socket Commands
   ******************************
   */

  FtpClient.prototype._quit = function() {
    var deferred = Q.defer();
    var cmd = "QUIT";

    function parse(data) {
      deferred.resolve();
    }

    this._controlCommand(cmd, 221, parse);

    return deferred.promise;
  };

  FtpClient.prototype._user = function(username) {
    var deferred = Q.defer();
    var cmd = "USER";

    function parse(data) {
      deferred.resolve();
    }

    if (username !== undefined) {
      cmd += " " + username;
    }

    this._controlCommand(cmd, 331, parse);

    return deferred.promise;
  };

  FtpClient.prototype._pass = function(password) {
    var deferred = Q.defer();
    var cmd = "PASS";

    function parse(data) {
      deferred.resolve();
    }

    if (password !== undefined) {
      cmd += " " + password;
    }

    this._controlCommand(cmd, 230, parse);

    return deferred.promise;
  };

  FtpClient.prototype._feat = function() {
    var deferred = Q.defer();
    var cmd = "FEAT";

    function parse(data) {
      var features = this._parseFeat(data);

      this.features = features;
      deferred.resolve(features);
    }

    this._controlCommand(cmd, 211, parse);

    return deferred.promise;
  };

  FtpClient.prototype._type = function(type) {
    var deferred = Q.defer();
    var cmd = "TYPE";

    function parse(data) {
      deferred.resolve();
    }

    if (type !== undefined) {
      cmd += " " + type;
    }

    this._controlCommand(cmd, 200, parse);

    return deferred.promise;
  };

  FtpClient.prototype._pasv = function() {
    var deferred = Q.defer();
    var cmd = "PASV";

    function parse(data) {
      deferred.resolve(this._pasvToPort(data));
    }

    this._controlCommand(cmd, 227, parse);

    return deferred.promise;
  };

  FtpClient.prototype._list = function(pathname) {
    var deferred = Q.defer();
    var cmd = "LIST";

    function parse(data) {
      deferred.resolve(data);
    }

    if (pathname !== undefined) {
      cmd += " " + pathname;
    }

    this._controlCommand(cmd, 226, parse);

    return deferred.promise;
  };

  FtpClient.prototype._mlsd = function(pathname) {
    var deferred = Q.defer();
    var cmd = "MLSD";

    function parse(data) {
      deferred.resolve(data);
    }

    if (pathname !== undefined) {
      cmd += " " + pathname;
    }

    // 150 code for start of transfer; 226 for end
    this._controlCommand(cmd, 226, parse);

    return deferred.promise;
  };

  FtpClient.prototype._stat = function(pathname) {
    var deferred = Q.defer();
    var cmd = "STAT";

    function parse(data) {
      deferred.resolve(data);
    }

    if (pathname !== undefined) {
      cmd += " " + pathname;
    }

    this._controlCommand(cmd, 211, parse);

    return deferred.promise;
  };

  FtpClient.prototype._retr = function(pathname) {
    var deferred = Q.defer();
    var cmd = "RETR";

    function parse(data) {
      deferred.resolve(data);
    }

    if (pathname !== undefined) {
      cmd += " " + pathname;
    }

    this._controlCommand(cmd, 226, parse);

    return deferred.promise;
  };

  FtpClient.prototype._stor = function(pathname) {
    var deferred = Q.defer();
    var cmd = "STOR";

    function parse(data) {
      deferred.resolve(data);
    }

    if (pathname !== undefined) {
      cmd += " " + pathname;
    }

    this._controlCommand(cmd, 150, parse);

    return deferred.promise;
  };

  FtpClient.prototype._pwd =  function() {
    var deferred = Q.defer();
    var cmd = "PWD";

    function parse(data) {
      deferred.resolve(/"(.*?)"/.exec(data)[1]);
    }

    this._controlCommand(cmd, 257, parse);

    return deferred.promise;
  };

  FtpClient.prototype._cwd =  function(pathname) {
    var deferred = Q.defer();
    var cmd = "CWD";

    function parse(data) {
      deferred.resolve();
    }

    if (pathname !== undefined) {
      cmd += " " + pathname;
    }

    this._controlCommand(cmd, 250, parse);

    return deferred.promise;
  };

  FtpClient.prototype._mkd =  function(pathname) {
    var deferred = Q.defer();
    var cmd = "MKD";

    function parse(data) {
      deferred.resolve();
    }

    if (pathname !== undefined) {
      cmd += " " + pathname;
    }

    this._controlCommand(cmd, 257, parse);

    return deferred.promise;
  };

  FtpClient.prototype._rmd =  function(pathname) {
    var deferred = Q.defer();
    var cmd = "RMD";

    function parse(data) {
      deferred.resolve();
    }

    if (pathname !== undefined) {
      cmd += " " + pathname;
    }

    this._controlCommand(cmd, 250, parse);

    return deferred.promise;
  };

  FtpClient.prototype._dele =  function(pathname) {
    var deferred = Q.defer();
    var cmd = "DELE";

    function parse(data) {
      deferred.resolve();
    }

    if (pathname !== undefined) {
      cmd += " " + pathname;
    }

    this._controlCommand(cmd, 250, parse);

    return deferred.promise;
  };

  FtpClient.prototype._rnfr =  function(pathname) {
    var deferred = Q.defer();
    var cmd = "RNFR";

    function parse(data) {
      deferred.resolve();
    }

    if (pathname !== undefined) {
      cmd += " " + pathname;
    }

    this._controlCommand(cmd, 350, parse);

    return deferred.promise;
  };

  FtpClient.prototype._rnto =  function(pathname) {
    var deferred = Q.defer();
    var cmd = "RNTO";

    function parse(data) {
      deferred.resolve();
    }

    if (pathname !== undefined) {
      cmd += " " + pathname;
    }

    this._controlCommand(cmd, 250, parse);

    return deferred.promise;
  };

  FtpClient.prototype._noop =  function() {
    var deferred = Q.defer();
    var cmd = "NOOP";

    function parse(data) {
      deferred.resolve();
    }

    this._controlCommand(cmd, 200, parse);

    return deferred.promise;
  };

  /**
   *
   * Parse FTP Commands Responces
   *******************************
   */
  FtpClient.prototype._responseToCode = function(resp) {
    return +resp.trim().split("\n").slice(-1)[0].substring(0,3);
  };

  FtpClient.prototype._pasvToPort = function(pasv) {
    var pasvs = pasv.match(/\d+/g);
    var port = +pasvs[6] + 256 * +pasvs[5];

    return port;
  };

  FtpClient.prototype._parseFeat = function(feat) {
    var lines = feat.split("\n");
    var features = {};

    lines.forEach(function(line) {
      if (line.indexOf("MLST") !== -1) {
        features.mlst = true;
      } else if (line.indexOf("UTF8") !== -1) {
        features.utf8 = true;
      }
    });

    return  features;
  };

  FtpClient.prototype._parseList = function(list) {
    var lines = list.split("\n");
    
    function chmod_num(perm){
      var owner = group = other = 0;

      if(perm[1]==='r') owner+=4;
      if(perm[2]==='w') owner+=2;
      if(perm[3]==='x') owner+=1;
      if(perm[4]==='r') group+=4;
      if(perm[5]==='w') group+=2;
      if(perm[6]==='x') group+=1;
      if(perm[7]==='r') other+=4;
      if(perm[8]==='w') other+=2;
      if(perm[9]==='x') other+=1;

      return ''+owner+group+other;
    }

    var files = lines.map(function(line) {
      var props = line.match(/\S+/g);

      if (props === null || props.length < 7) {
        return;
      }

      // Convert string to date
      var m = props[5];
      var d = props[6];
      var yh = props[7];
      var y, t;

      if (yh.indexOf(":")) {
        y = new Date().getFullYear();
        h = yh;
      } else {
        y = yh;
        h = "00:00";
      }

      modifiedDate = new Date([y,m,d,h].join(" "));

      var file = {
        perm: props[0],
        permn: chmod_num(props[0]),
        contentsLength: +props[1],
        owner: props[2],
        group: props[3],
        size: +props[4],
        modify: modifiedDate,
        name: props.splice(8, props.length - 8).join(" "),
        isDirectory: /^d/.test(props[0])
      };

      return file;
    }.bind(this));

    return files;
  };

  FtpClient.prototype._parseMlsd = function(mlsd) {
    var lines = mlsd.split("\n");

    var files = lines.map(function(line) {
      var file = {};
      var facts = line.split(";");

      file.name = facts.pop().trim();

      facts.forEach(function(fact) {
        var segs    = fact.match(/[^\.=]+/g);
        var value   = segs.pop();
        var keyword = segs.pop().toLowerCase();

        file[keyword] = value;
      });

      if (file.modify) {
        // YYYYMMDDHHmm
        var dt = file.modify.match(/(\d{4})(\d{2})(\d{2})(\d{2})/);
        var modify = new Date();

        modify.setFullYear(dt[1]);
        modify.setMonth(+dt[2] -1);
        modify.setHours(dt[3], dt[4]);
        file.modify = modify;
      }

      file.isDirectory = /dir/.test(file.type);

      return file;
    });

    return files;
  };

  /**
   * Wrapper function for logging
   */
  function log(msg) {
    console.log(msg);
  }

  /**
   * Wrapper function for error logging
   */
  function error(msg) {
    console.error(msg);
  }

  exports.FtpClient = FtpClient;

})(window);
