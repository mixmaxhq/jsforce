(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g=(g.jsforce||(g.jsforce = {}));g=(g.modules||(g.modules = {}));g=(g.api||(g.api = {}));g.Bulk = f()}})(function(){var define,module,exports;return (function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
(function (process){
/*global process*/
/**
 * @file Manages Salesforce Bulk API related operations
 * @author Shinichi Tomita <shinichi.tomita@gmail.com>
 */

'use strict';

var inherits     = window.jsforce.require('inherits'),
    stream       = window.jsforce.require('readable-stream'),
    Duplex       = stream.Duplex,
    events       = window.jsforce.require('events'),
    _            = window.jsforce.require('lodash/core'),
    joinStreams  = window.jsforce.require('multistream'),
    jsforce      = window.jsforce.require('./core'),
    RecordStream = window.jsforce.require('./record-stream'),
    Promise      = window.jsforce.require('./promise'),
    HttpApi      = window.jsforce.require('./http-api');

/*--------------------------------------------*/

/**
 * Class for Bulk API Job
 *
 * @protected
 * @class Bulk~Job
 * @extends events.EventEmitter
 *
 * @param {Bulk} bulk - Bulk API object
 * @param {String} [type] - SObject type
 * @param {String} [operation] - Bulk load operation ('insert', 'update', 'upsert', 'delete', or 'hardDelete')
 * @param {Object} [options] - Options for bulk loading operation
 * @param {String} [options.extIdField] - External ID field name (used when upsert operation).
 * @param {String} [options.concurrencyMode] - 'Serial' or 'Parallel'. Defaults to Parallel.
 * @param {String} [jobId] - Job ID (if already available)
 */
var Job = function(bulk, type, operation, options, jobId) {
  this._bulk = bulk;
  this.type = type;
  this.operation = operation;
  this.options = options || {};
  this.id = jobId;
  this.state = this.id ? 'Open' : 'Unknown';
  this._batches = {};
};

inherits(Job, events.EventEmitter);

/**
 * @typedef {Object} Bulk~JobInfo
 * @prop {String} id - Job ID
 * @prop {String} object - Object type name
 * @prop {String} operation - Operation type of the job
 * @prop {String} state - Job status
 */

/**
 * Return latest jobInfo from cache
 *
 * @method Bulk~Job#info
 * @param {Callback.<Bulk~JobInfo>} [callback] - Callback function
 * @returns {Promise.<Bulk~JobInfo>}
 */
Job.prototype.info = function(callback) {
  var self = this;
  // if cache is not available, check the latest
  if (!this._jobInfo) {
    this._jobInfo = this.check();
  } else if (self.options.pkChunking) {
    return this._jobInfo.then((info) => {
      if (info.numberBatchesTotal !== '0' && info.numberBatchesTotal === info.numberBatchesCompleted) {
        self._jobInfo = Promise.resolve(info);
      } else {
        self._jobInfo = self.check();
      }
      return self._jobInfo.thenCall(callback);
    })
  }

  return this._jobInfo.thenCall(callback);
};

/**
 * Open new job and get jobinfo
 *
 * @method Bulk~Job#open
 * @param {Callback.<Bulk~JobInfo>} [callback] - Callback function
 * @returns {Promise.<Bulk~JobInfo>}
 */
Job.prototype.open = function(callback) {
  var self = this;
  var bulk = this._bulk;
  var logger = bulk._logger;

  // if not requested opening job
  if (!this._jobInfo) {
    var operation = this.operation.toLowerCase();
    if (operation === 'harddelete') { operation = 'hardDelete'; }
    var body = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<jobInfo  xmlns="http://www.force.com/2009/06/asyncapi/dataload">',
        '<operation>' + operation + '</operation>',
        '<object>' + this.type + '</object>',
        (this.options.extIdField ?
         '<externalIdFieldName>'+this.options.extIdField+'</externalIdFieldName>' :
         ''),
        (this.options.concurrencyMode ?
         '<concurrencyMode>'+this.options.concurrencyMode+'</concurrencyMode>' :
         ''),
        (this.options.assignmentRuleId ?
          '<assignmentRuleId>' + this.options.assignmentRuleId + '</assignmentRuleId>' :
          ''),
        '<contentType>CSV</contentType>',
      '</jobInfo>'
    ].join('');

    var headers = {
      'Content-Type' : 'application/xml; charset=utf-8'
    };
    var pkChunking = this.options.pkChunking;
    if(pkChunking) {
      var chunkingParams = Object.keys(pkChunking)
        .filter(function(key) {
          return ['chunkSize', 'parent', 'startRow'].indexOf(key) >= 0;
        })
        .map(function(key) {
          return key + '=' + pkChunking[key];
        });
      if(chunkingParams.length)
        headers['Sforce-Enable-PKChunking'] = chunkingParams.join('; ');
    }

    this._jobInfo = bulk._request({
      method : 'POST',
      path : "/job",
      body : body,
      headers : headers,
      responseType: "application/xml"
    }).then(function(res) {
      self.emit("open", res.jobInfo);
      self.id = res.jobInfo.id;
      self.state = res.jobInfo.state;
      return res.jobInfo;
    }, function(err) {
      self.emit("error", err);
      throw err;
    });
  }
  return this._jobInfo.thenCall(callback);
};

/**
 * Create a new batch instance in the job
 *
 * @method Bulk~Job#createBatch
 * @returns {Bulk~Batch}
 */
Job.prototype.createBatch = function() {
  var batch = new Batch(this);
  var self = this;
  batch.on('queue', function() {
    self._batches[batch.id] = batch;
  });
  return batch;
};

/**
 * Get a batch instance specified by given batch ID
 *
 * @method Bulk~Job#batch
 * @param {String} batchId - Batch ID
 * @returns {Bulk~Batch}
 */
Job.prototype.batch = function(batchId) {
  var batch = this._batches[batchId];
  if (!batch) {
    batch = new Batch(this, batchId);
    this._batches[batchId] = batch;
  }
  return batch;
};

/**
 * Check the latest job status from server
 *
 * @method Bulk~Job#check
 * @param {Callback.<Bulk~JobInfo>} [callback] - Callback function
 * @returns {Promise.<Bulk~JobInfo>}
 */
Job.prototype.check = function(callback) {
  var self = this;
  var bulk = this._bulk;
  var logger = bulk._logger;

  this._jobInfo = this._waitAssign().then(function() {
    return bulk._request({
      method : 'GET',
      path : "/job/" + self.id,
      responseType: "application/xml"
    });
  }).then(function(res) {
    logger.debug(res.jobInfo);
    self.id = res.jobInfo.id;
    self.type = res.jobInfo.object;
    self.operation = res.jobInfo.operation;
    self.state = res.jobInfo.state;
    return res.jobInfo;
  });
  return this._jobInfo.thenCall(callback);
};

/**
 * Wait till the job is assigned to server
 *
 * @method Bulk~Job#info
 * @param {Callback.<Bulk~JobInfo>} [callback] - Callback function
 * @returns {Promise.<Bulk~JobInfo>}
 */
Job.prototype._waitAssign = function(callback) {
  return (this.id ? Promise.resolve({ id: this.id }) : this.open()).thenCall(callback);
};


/**
 * List all registered batch info in job
 *
 * @method Bulk~Job#list
 * @param {Callback.<Array.<Bulk~BatchInfo>>} [callback] - Callback function
 * @returns {Promise.<Array.<Bulk~BatchInfo>>}
 */
Job.prototype.list = function(callback) {
  var self = this;
  var bulk = this._bulk;
  var logger = bulk._logger;

  return this._waitAssign().then(function() {
    return bulk._request({
      method : 'GET',
      path : "/job/" + self.id + "/batch",
      responseType: "application/xml"
    });
  }).then(function(res) {
    logger.debug(res.batchInfoList.batchInfo);
    var batchInfoList = res.batchInfoList;
    batchInfoList = _.isArray(batchInfoList.batchInfo) ? batchInfoList.batchInfo : [ batchInfoList.batchInfo ];
    return batchInfoList;
  }).thenCall(callback);
};

Job.prototype.retrieveBatches = function(callback) {
  var self = this;

  return self.list().then((batchInfoList) => {
    return Promise.all(batchInfoList.map(function(batchInfo) {
      if (batchInfo.state === 'NotProcessed' || parseInt(batchInfo.numberRecordsProcessed, 10) === 0) return Promise.resolve();
      if (batchInfo.state === 'Failed' && parseInt(batchInfo.numberRecordsProcessed, 10) === 0) {
        throw new Error(batchInfo.stateMessage)
      }
      return self.batch(batchInfo.id).retrieve();
    }));
  }).then(function(batchResults) {
    const results = [];
    batchResults.forEach(function(batchResult) {
      if (!batchResult) return;
      results.push(...batchResult);
    });
    return results;
  }).then(function(results) {
    return self.close().then(function() {
      return results;
    })
  }).fail(function(err) {
    self.emit("error", err);
    return self.abort().then(() => {
      throw err;
    });
  }).thenCall(callback);
}

/**
 * Close opened job
 *
 * @method Bulk~Job#close
 * @param {Callback.<Bulk~JobInfo>} [callback] - Callback function
 * @returns {Promise.<Bulk~JobInfo>}
 */
Job.prototype.close = function() {
  var self = this;
  return this._changeState("Closed").then(function(jobInfo) {
    self.id = null;
    self.emit("close", jobInfo);
    return jobInfo;
  }, function(err) {
    self.emit("error", err);
    throw err;
  });
};

/**
 * Set the status to abort
 *
 * @method Bulk~Job#abort
 * @param {Callback.<Bulk~JobInfo>} [callback] - Callback function
 * @returns {Promise.<Bulk~JobInfo>}
 */
Job.prototype.abort = function() {
  var self = this;
  return this._changeState("Aborted").then(function(jobInfo) {
    self.id = null;
    self.emit("abort", jobInfo);
    return jobInfo;
  }, function(err) {
    self.emit("error", err);
    throw err;
  });
};

/**
 * @private
 */
Job.prototype._changeState = function(state, callback) {
  var self = this;
  var bulk = this._bulk;
  var logger = bulk._logger;

  this._jobInfo = this._waitAssign().then(function() {
    var body = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<jobInfo xmlns="http://www.force.com/2009/06/asyncapi/dataload">',
        '<state>' + state + '</state>',
      '</jobInfo>'
    ].join('');
    return bulk._request({
      method : 'POST',
      path : "/job/" + self.id,
      body : body,
      headers : {
        "Content-Type" : "application/xml; charset=utf-8"
      },
      responseType: "application/xml"
    });
  }).then(function(res) {
    logger.debug(res.jobInfo);
    self.state = res.jobInfo.state;
    return res.jobInfo;
  });
  return this._jobInfo.thenCall(callback);

};


/*--------------------------------------------*/

/**
 * Batch (extends RecordStream)
 *
 * @protected
 * @class Bulk~Batch
 * @extends {stream.Writable}
 * @implements {Promise.<Array.<RecordResult>>}
 * @param {Bulk~Job} job - Bulk job object
 * @param {String} [batchId] - Batch ID (if already available)
 */
var Batch = function(job, batchId) {
  Batch.super_.call(this, { objectMode: true });
  this.job = job;
  this.id = batchId;
  this._bulk = job._bulk;
  this._deferred = Promise.defer();
  this._setupDataStreams();
};

inherits(Batch, stream.Writable);


/**
 * @private
 */
Batch.prototype._setupDataStreams = function() {
  var batch = this;
  var converterOptions = { nullValue : '#N/A' };
  this._uploadStream = new RecordStream.Serializable();
  this._uploadDataStream = this._uploadStream.stream('csv', converterOptions);
  this._downloadStream = new RecordStream.Parsable();
  this._downloadDataStream = this._downloadStream.stream('csv', converterOptions);

  this.on('finish', function() {
    batch._uploadStream.end();
  });
  this._uploadDataStream.once('readable', function() {
    batch.job.open().then(function() {
      // pipe upload data to batch API request stream
      batch._uploadDataStream.pipe(batch._createRequestStream());
    });
  });

  // duplex data stream, opened access to API programmers by Batch#stream()
  var dataStream = this._dataStream = new Duplex();
  dataStream._write = function(data, enc, cb) {
    batch._uploadDataStream.write(data, enc, cb);
  };
  dataStream.on('finish', function() {
    batch._uploadDataStream.end();
  });

  this._downloadDataStream.on('readable', function() {
    dataStream.read(0);
  });
  this._downloadDataStream.on('end', function() {
    dataStream.push(null);
  });
  dataStream._read = function(size) {
    var chunk;
    while ((chunk = batch._downloadDataStream.read()) !== null) {
      dataStream.push(chunk);
    }
  };
};

/**
 * Connect batch API and create stream instance of request/response
 *
 * @private
 * @returns {stream.Duplex}
 */
Batch.prototype._createRequestStream = function() {
  var batch = this;
  var bulk = batch._bulk;
  var logger = bulk._logger;

  return bulk._request({
    method : 'POST',
    path : "/job/" + batch.job.id + "/batch",
    headers: {
      "Content-Type": "text/csv"
    },
    responseType: "application/xml"
  }, function(err, res) {
    if (err) {
      batch.emit('error', err);
    } else {
      logger.debug(res.batchInfo);
      batch.id = res.batchInfo.id;
      batch.emit('queue', res.batchInfo);
    }
  }).stream();
};

/**
 * Implementation of Writable
 *
 * @override
 * @private
 */
Batch.prototype._write = function(record, enc, cb) {
  record = _.clone(record);
  if (this.job.operation === "insert") {
    delete record.Id;
  } else if (this.job.operation === "delete") {
    record = { Id: record.Id };
  }
  delete record.type;
  delete record.attributes;
  this._uploadStream.write(record, enc, cb);
};

/**
 * Returns duplex stream which accepts CSV data input and batch result output
 *
 * @returns {stream.Duplex}
 */
Batch.prototype.stream = function() {
  return this._dataStream;
};

/**
 * Execute batch operation
 *
 * @method Bulk~Batch#execute
 * @param {Array.<Record>|stream.Stream|String} [input] - Input source for batch operation. Accepts array of records, CSV string, and CSV data input stream in insert/update/upsert/delete/hardDelete operation, SOQL string in query operation.
 * @param {Callback.<Array.<RecordResult>|Array.<BatchResultInfo>>} [callback] - Callback function
 * @returns {Bulk~Batch}
 */
Batch.prototype.run =
Batch.prototype.exec =
Batch.prototype.execute = function(input, callback) {
  var self = this;

  if (typeof input === 'function') { // if input argument is omitted
    callback = input;
    input = null;
  }

  // if batch is already executed
  if (this._result) {
    throw new Error("Batch already executed.");
  }

  var rdeferred = Promise.defer();
  this._result = rdeferred.promise;
  this._result.then(function(res) {
    self._deferred.resolve(res);
  }, function(err) {
    self._deferred.reject(err);
  });
  this.once('response', function(res) {
    rdeferred.resolve(res);
  });
  this.once('error', function(err) {
    rdeferred.reject(err);
  });

  if (_.isObject(input) && _.isFunction(input.pipe)) { // if input has stream.Readable interface
    input.pipe(this._dataStream);
  } else {
    var data;
    if (_.isArray(input)) {
      _.forEach(input, function(record) {
        Object.keys(record).forEach(function(key) {
          if (typeof record[key] === 'boolean') {
            record[key] = String(record[key])
          }
        })
        self.write(record);
      });
      self.end();
    } else if (_.isString(input)){
      data = input;
      this._dataStream.write(data, 'utf8');
      this._dataStream.end();
    }
  }

  // return Batch instance for chaining
  return this.thenCall(callback);
};

/**
 * Promise/A+ interface
 * http://promises-aplus.github.io/promises-spec/
 *
 * Delegate to deferred promise, return promise instance for batch result
 *
 * @method Bulk~Batch#then
 */
Batch.prototype.then = function(onResolved, onReject, onProgress) {
  return this._deferred.promise.then(onResolved, onReject, onProgress);
};

/**
 * Promise/A+ extension
 * Call "then" using given node-style callback function
 *
 * @method Bulk~Batch#thenCall
 */
Batch.prototype.thenCall = function(callback) {
  if (_.isFunction(callback)) {
    this.then(function(res) {
      process.nextTick(function() {
        callback(null, res);
      });
    }, function(err) {
      process.nextTick(function() {
        callback(err);
      });
    });
  }
  return this;
};

/**
 * @typedef {Object} Bulk~BatchInfo
 * @prop {String} id - Batch ID
 * @prop {String} jobId - Job ID
 * @prop {String} state - Batch state
 * @prop {String} stateMessage - Batch state message
 */

/**
 * Check the latest batch status in server
 *
 * @method Bulk~Batch#check
 * @param {Callback.<Bulk~BatchInfo>} [callback] - Callback function
 * @returns {Promise.<Bulk~BatchInfo>}
 */
Batch.prototype.check = function(callback) {
  var self = this;
  var bulk = this._bulk;
  var logger = bulk._logger;
  var jobId = this.job.id;
  var batchId = this.id;

  if (!jobId || !batchId) {
    throw new Error("Batch not started.");
  }

  return bulk._request({
    method : 'GET',
    path : "/job/" + jobId + "/batch/" + batchId,
    responseType: "application/xml"
  }).then(function(res) {
    logger.debug(res.batchInfo);
    return res.batchInfo;
  }).thenCall(callback);
};


/**
 * Polling the batch result and retrieve
 *
 * @method Bulk~Batch#poll
 * @param {Number} interval - Polling interval in milliseconds
 * @param {Number} timeout - Polling timeout in milliseconds
 */
Batch.prototype.poll = function(interval, timeout) {
  var self = this;
  var job = this.job;
  var batchId = this.id;

  if (!job.id || !batchId) {
    throw new Error("Batch not started.");
  }
  var startTime = new Date().getTime();
  var poll = function() {
    var now = new Date().getTime();
    if (startTime + timeout < now) {
      var err = new Error("Polling time out. Job Id = " + job.id + " , batch Id = " + batchId);
      err.name = 'PollingTimeout';
      err.jobId = job.id;
      err.batchId = batchId;
      self.emit('error', err);
      return;
    }
    job.info().then(function(jobInfo) {
      self.check(function(err, res) {
        const batchesComplete = jobInfo.numberBatchesTotal !== '0' && jobInfo.numberBatchesTotal === jobInfo.numberBatchesCompleted;
        if (err) {
          self.emit('error', err);
        } else {
          if (res.state === "Failed") {
            if (parseInt(res.numberRecordsProcessed, 10) > 0) {
              self.retrieve();
            } else {
              self.emit('error', new Error(res.stateMessage));
            }
          } else if (res.state === "Completed"){
            self.retrieve();
          } else if (res.state === "NotProcessed" && batchesComplete) {
            job.retrieveBatches()
              .then((results) => {
                self.emit('response', results);
              })
              .fail(function(err) {
                self.emit('error', err);
              });
          } else {
            self.emit('progress', res);
            setTimeout(poll, interval);
          }
        }
      });
    })
  };
  setTimeout(poll, interval);
};

/**
 * @typedef {Object} Bulk~BatchResultInfo
 * @prop {String} id - Batch result ID
 * @prop {String} batchId - Batch ID which includes this batch result.
 * @prop {String} jobId - Job ID which includes this batch result.
 */

/**
 * Retrieve batch result
 *
 * @method Bulk~Batch#retrieve
 * @param {Callback.<Array.<RecordResult>|Array.<Bulk~BatchResultInfo>>} [callback] - Callback function
 * @returns {Promise.<Array.<RecordResult>|Array.<Bulk~BatchResultInfo>>}
 */
Batch.prototype.retrieve = function(callback) {
  var self = this;
  var bulk = this._bulk;
  var jobId = this.job.id;
  var job = this.job;
  var batchId = this.id;

  if (!jobId || !batchId) {
    throw new Error("Batch not started.");
  }

  return job.info().then(function(jobInfo) {
    return bulk._request({
      method : 'GET',
      path : "/job/" + jobId + "/batch/" + batchId + "/result"
    });
  }).then(function(res) {
    var results;
    if (job.operation === 'query') {
      var conn = bulk._conn;
      var resultIds = res['result-list'].result;
      results = res['result-list'].result;
      results = _.map(_.isArray(results) ? results : [ results ], function(id) {
        return {
          id: id,
          batchId: batchId,
          jobId: jobId
        };
      });
    } else {
      results = _.map(res, function(ret) {
        return {
          id: ret.Id || null,
          success: ret.Success === "true",
          errors: ret.Error ? [ ret.Error ] : []
        };
      });
    }
    self.emit('response', results);
    return results;
  }).fail(function(err) {
    self.emit('error', err);
    throw err;
  }).thenCall(callback);
};

/**
 * Fetch query result as a record stream
 * @param {String} resultId - Result id
 * @returns {RecordStream} - Record stream, convertible to CSV data stream
 */
Batch.prototype.result = function(resultId) {
  var jobId = this.job.id;
  var batchId = this.id;
  if (!jobId || !batchId) {
    throw new Error("Batch not started.");
  }
  var resultStream = new RecordStream.Parsable();
  var resultDataStream = resultStream.stream('csv');

  var reqStream = this._bulk._request({
    method : 'GET',
    path : "/job/" + jobId + "/batch/" + batchId + "/result/" + resultId,
    responseType: "application/octet-stream",
    forever: true,
    gzip: true
  }).stream()
    .on('error', err => resultDataStream.emit('error', err))
    .pipe(resultDataStream);

  return resultStream;
};

/*--------------------------------------------*/
/**
 * @private
 */
var BulkApi = function() {
  BulkApi.super_.apply(this, arguments);
};

inherits(BulkApi, HttpApi);

BulkApi.prototype.beforeSend = function(request) {
  request.headers = request.headers || {};
  request.headers["X-SFDC-SESSION"] = this._conn.accessToken;
};

BulkApi.prototype.isSessionExpired = function(response) {
  return response.statusCode === 400 &&
    /<exceptionCode>InvalidSessionId<\/exceptionCode>/.test(response.body);
};

BulkApi.prototype.hasErrorInResponseBody = function(body) {
  return !!body.error;
};

BulkApi.prototype.parseError = function(body) {
  return {
    errorCode: body.error.exceptionCode,
    message: body.error.exceptionMessage
  };
};

/*--------------------------------------------*/

/**
 * Class for Bulk API
 *
 * @class
 * @param {Connection} conn - Connection object
 */
var Bulk = function(conn) {
  this._conn = conn;
  this._logger = conn._logger;
};

/**
 * Polling interval in milliseconds
 * @type {Number}
 */
Bulk.prototype.pollInterval = 1000;

/**
 * Polling timeout in milliseconds
 * @type {Number}
 */
Bulk.prototype.pollTimeout = 10000;

/** @private **/
Bulk.prototype._request = function(request, callback) {
  var conn = this._conn;
  request = _.clone(request);
  var baseUrl = [ conn.instanceUrl, "services/async", conn.version ].join('/');
  request.url = baseUrl + request.path;
  var options = { responseType: request.responseType };
  delete request.path;
  delete request.responseType;
  return new BulkApi(this._conn, options)
    .on('requestDuration', (duration) => conn.emit('requestDuration', duration))
    .request(request)
    .thenCall(callback);
};

/**
 * Create and start bulkload job and batch
 *
 * @param {String} type - SObject type
 * @param {String} operation - Bulk load operation ('insert', 'update', 'upsert', 'delete', or 'hardDelete')
 * @param {Object} [options] - Options for bulk loading operation
 * @param {String} [options.extIdField] - External ID field name (used when upsert operation).
 * @param {String} [options.concurrencyMode] - 'Serial' or 'Parallel'. Defaults to Parallel.
 * @param {Array.<Record>|stream.Stream|String} [input] - Input source for bulkload. Accepts array of records, CSV string, and CSV data input stream in insert/update/upsert/delete/hardDelete operation, SOQL string in query operation.
 * @param {Callback.<Array.<RecordResult>|Array.<Bulk~BatchResultInfo>>} [callback] - Callback function
 * @returns {Bulk~Batch}
 */
Bulk.prototype.load = function(type, operation, options, input, callback) {
  var self = this;
  if (!type || !operation) {
    throw new Error("Insufficient arguments. At least, 'type' and 'operation' are required.");
  }
  if (!_.isObject(options) || options.constructor !== Object) { // when options is not plain hash object, it is omitted
    callback = input;
    input = options;
    options = null;
  }
  var job = this.createJob(type, operation, options);
  job.once('error', function (error) {
    if (batch) {
      batch.emit('error', error); // pass job error to batch
    }
  });
  var batch = job.createBatch();
  var cleanup = function() {
    batch = null;
    job.close();
  };
  var cleanupOnError = function(err) {
    if (err.name !== 'PollingTimeout') {
      cleanup();
    }
  };
  batch.on('response', cleanup);
  batch.on('error', cleanupOnError);
  batch.on('queue', function() { batch.poll(self.pollInterval, self.pollTimeout); });
  return batch.execute(input, callback);
};

/**
 * Execute bulk query and get record stream
 *
 * @param {String} soql - SOQL to execute in bulk job
 * @param {Object} options - Options on how to execute the Job
 * @returns {RecordStream.Parsable} - Record stream, convertible to CSV data stream
 */
Bulk.prototype.query = function(soql, options) {
  var m = soql.replace(/\([\s\S]+\)/g, '').match(/FROM\s+(\w+)/i);
  if (!m) {
    throw new Error("No sobject type found in query, maybe caused by invalid SOQL.");
  }
  var type = m[1];
  var self = this;
  var recordStream = new RecordStream.Parsable();
  var dataStream = recordStream.stream('csv');

  this.load(type, "query", options || {}, soql).then(function(results) {
    var lazyLoadedResultStreams = results.map(function(result) {
      const batch = self
        .job(result.jobId)
        .batch(result.batchId);

      return function() {
        return batch
          .result(result.id)
          .stream();
      }
    });

    joinStreams(lazyLoadedResultStreams)
      .on('error', err => dataStream.emit('error', err))
      .on('end', () => dataStream.emit('end'))
      .pipe(dataStream);
  }).fail(function(err) {
    dataStream.emit('error', err);
  });
  return recordStream;
};


/**
 * Create a new job instance
 *
 * @param {String} type - SObject type
 * @param {String} operation - Bulk load operation ('insert', 'update', 'upsert', 'delete', 'hardDelete', or 'query')
 * @param {Object} [options] - Options for bulk loading operation
 * @returns {Bulk~Job}
 */
Bulk.prototype.createJob = function(type, operation, options) {
  return new Job(this, type, operation, options);
};

/**
 * Get a job instance specified by given job ID
 *
 * @param {String} jobId - Job ID
 * @returns {Bulk~Job}
 */
Bulk.prototype.job = function(jobId) {
  return new Job(this, null, null, null, jobId);
};


/*--------------------------------------------*/
/*
 * Register hook in connection instantiation for dynamically adding this API module features
 */
jsforce.on('connection:new', function(conn) {
  conn.bulk = new Bulk(conn);
});


module.exports = Bulk;

}).call(this,require('_process'))

},{"_process":2}],2:[function(require,module,exports){
// shim for using process in browser
var process = module.exports = {};

// cached from whatever global is present so that test runners that stub it
// don't break things.  But we need to wrap it in a try catch in case it is
// wrapped in strict mode code which doesn't define any globals.  It's inside a
// function because try/catches deoptimize in certain engines.

var cachedSetTimeout;
var cachedClearTimeout;

function defaultSetTimout() {
    throw new Error('setTimeout has not been defined');
}
function defaultClearTimeout () {
    throw new Error('clearTimeout has not been defined');
}
(function () {
    try {
        if (typeof setTimeout === 'function') {
            cachedSetTimeout = setTimeout;
        } else {
            cachedSetTimeout = defaultSetTimout;
        }
    } catch (e) {
        cachedSetTimeout = defaultSetTimout;
    }
    try {
        if (typeof clearTimeout === 'function') {
            cachedClearTimeout = clearTimeout;
        } else {
            cachedClearTimeout = defaultClearTimeout;
        }
    } catch (e) {
        cachedClearTimeout = defaultClearTimeout;
    }
} ())
function runTimeout(fun) {
    if (cachedSetTimeout === setTimeout) {
        //normal enviroments in sane situations
        return setTimeout(fun, 0);
    }
    // if setTimeout wasn't available but was latter defined
    if ((cachedSetTimeout === defaultSetTimout || !cachedSetTimeout) && setTimeout) {
        cachedSetTimeout = setTimeout;
        return setTimeout(fun, 0);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedSetTimeout(fun, 0);
    } catch(e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't trust the global object when called normally
            return cachedSetTimeout.call(null, fun, 0);
        } catch(e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error
            return cachedSetTimeout.call(this, fun, 0);
        }
    }


}
function runClearTimeout(marker) {
    if (cachedClearTimeout === clearTimeout) {
        //normal enviroments in sane situations
        return clearTimeout(marker);
    }
    // if clearTimeout wasn't available but was latter defined
    if ((cachedClearTimeout === defaultClearTimeout || !cachedClearTimeout) && clearTimeout) {
        cachedClearTimeout = clearTimeout;
        return clearTimeout(marker);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedClearTimeout(marker);
    } catch (e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't  trust the global object when called normally
            return cachedClearTimeout.call(null, marker);
        } catch (e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error.
            // Some versions of I.E. have different rules for clearTimeout vs setTimeout
            return cachedClearTimeout.call(this, marker);
        }
    }



}
var queue = [];
var draining = false;
var currentQueue;
var queueIndex = -1;

function cleanUpNextTick() {
    if (!draining || !currentQueue) {
        return;
    }
    draining = false;
    if (currentQueue.length) {
        queue = currentQueue.concat(queue);
    } else {
        queueIndex = -1;
    }
    if (queue.length) {
        drainQueue();
    }
}

function drainQueue() {
    if (draining) {
        return;
    }
    var timeout = runTimeout(cleanUpNextTick);
    draining = true;

    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        while (++queueIndex < len) {
            if (currentQueue) {
                currentQueue[queueIndex].run();
            }
        }
        queueIndex = -1;
        len = queue.length;
    }
    currentQueue = null;
    draining = false;
    runClearTimeout(timeout);
}

process.nextTick = function (fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
        for (var i = 1; i < arguments.length; i++) {
            args[i - 1] = arguments[i];
        }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
        runTimeout(drainQueue);
    }
};

// v8 likes predictible objects
function Item(fun, array) {
    this.fun = fun;
    this.array = array;
}
Item.prototype.run = function () {
    this.fun.apply(null, this.array);
};
process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues
process.versions = {};

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;
process.prependListener = noop;
process.prependOnceListener = noop;

process.listeners = function (name) { return [] }

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };

},{}]},{},[1])(1)
});

//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJsaWIvYXBpL2J1bGsuanMiLCJub2RlX21vZHVsZXMvcHJvY2Vzcy9icm93c2VyLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOztBQ0FBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDOTZCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBIiwiZmlsZSI6ImdlbmVyYXRlZC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzQ29udGVudCI6WyIoZnVuY3Rpb24oKXtmdW5jdGlvbiByKGUsbix0KXtmdW5jdGlvbiBvKGksZil7aWYoIW5baV0pe2lmKCFlW2ldKXt2YXIgYz1cImZ1bmN0aW9uXCI9PXR5cGVvZiByZXF1aXJlJiZyZXF1aXJlO2lmKCFmJiZjKXJldHVybiBjKGksITApO2lmKHUpcmV0dXJuIHUoaSwhMCk7dmFyIGE9bmV3IEVycm9yKFwiQ2Fubm90IGZpbmQgbW9kdWxlICdcIitpK1wiJ1wiKTt0aHJvdyBhLmNvZGU9XCJNT0RVTEVfTk9UX0ZPVU5EXCIsYX12YXIgcD1uW2ldPXtleHBvcnRzOnt9fTtlW2ldWzBdLmNhbGwocC5leHBvcnRzLGZ1bmN0aW9uKHIpe3ZhciBuPWVbaV1bMV1bcl07cmV0dXJuIG8obnx8cil9LHAscC5leHBvcnRzLHIsZSxuLHQpfXJldHVybiBuW2ldLmV4cG9ydHN9Zm9yKHZhciB1PVwiZnVuY3Rpb25cIj09dHlwZW9mIHJlcXVpcmUmJnJlcXVpcmUsaT0wO2k8dC5sZW5ndGg7aSsrKW8odFtpXSk7cmV0dXJuIG99cmV0dXJuIHJ9KSgpIiwiLypnbG9iYWwgcHJvY2VzcyovXG4vKipcbiAqIEBmaWxlIE1hbmFnZXMgU2FsZXNmb3JjZSBCdWxrIEFQSSByZWxhdGVkIG9wZXJhdGlvbnNcbiAqIEBhdXRob3IgU2hpbmljaGkgVG9taXRhIDxzaGluaWNoaS50b21pdGFAZ21haWwuY29tPlxuICovXG5cbid1c2Ugc3RyaWN0JztcblxudmFyIGluaGVyaXRzICAgICA9IHdpbmRvdy5qc2ZvcmNlLnJlcXVpcmUoJ2luaGVyaXRzJyksXG4gICAgc3RyZWFtICAgICAgID0gd2luZG93LmpzZm9yY2UucmVxdWlyZSgncmVhZGFibGUtc3RyZWFtJyksXG4gICAgRHVwbGV4ICAgICAgID0gc3RyZWFtLkR1cGxleCxcbiAgICBldmVudHMgICAgICAgPSB3aW5kb3cuanNmb3JjZS5yZXF1aXJlKCdldmVudHMnKSxcbiAgICBfICAgICAgICAgICAgPSB3aW5kb3cuanNmb3JjZS5yZXF1aXJlKCdsb2Rhc2gvY29yZScpLFxuICAgIGpvaW5TdHJlYW1zICA9IHdpbmRvdy5qc2ZvcmNlLnJlcXVpcmUoJ211bHRpc3RyZWFtJyksXG4gICAganNmb3JjZSAgICAgID0gd2luZG93LmpzZm9yY2UucmVxdWlyZSgnLi9jb3JlJyksXG4gICAgUmVjb3JkU3RyZWFtID0gd2luZG93LmpzZm9yY2UucmVxdWlyZSgnLi9yZWNvcmQtc3RyZWFtJyksXG4gICAgUHJvbWlzZSAgICAgID0gd2luZG93LmpzZm9yY2UucmVxdWlyZSgnLi9wcm9taXNlJyksXG4gICAgSHR0cEFwaSAgICAgID0gd2luZG93LmpzZm9yY2UucmVxdWlyZSgnLi9odHRwLWFwaScpO1xuXG4vKi0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tKi9cblxuLyoqXG4gKiBDbGFzcyBmb3IgQnVsayBBUEkgSm9iXG4gKlxuICogQHByb3RlY3RlZFxuICogQGNsYXNzIEJ1bGt+Sm9iXG4gKiBAZXh0ZW5kcyBldmVudHMuRXZlbnRFbWl0dGVyXG4gKlxuICogQHBhcmFtIHtCdWxrfSBidWxrIC0gQnVsayBBUEkgb2JqZWN0XG4gKiBAcGFyYW0ge1N0cmluZ30gW3R5cGVdIC0gU09iamVjdCB0eXBlXG4gKiBAcGFyYW0ge1N0cmluZ30gW29wZXJhdGlvbl0gLSBCdWxrIGxvYWQgb3BlcmF0aW9uICgnaW5zZXJ0JywgJ3VwZGF0ZScsICd1cHNlcnQnLCAnZGVsZXRlJywgb3IgJ2hhcmREZWxldGUnKVxuICogQHBhcmFtIHtPYmplY3R9IFtvcHRpb25zXSAtIE9wdGlvbnMgZm9yIGJ1bGsgbG9hZGluZyBvcGVyYXRpb25cbiAqIEBwYXJhbSB7U3RyaW5nfSBbb3B0aW9ucy5leHRJZEZpZWxkXSAtIEV4dGVybmFsIElEIGZpZWxkIG5hbWUgKHVzZWQgd2hlbiB1cHNlcnQgb3BlcmF0aW9uKS5cbiAqIEBwYXJhbSB7U3RyaW5nfSBbb3B0aW9ucy5jb25jdXJyZW5jeU1vZGVdIC0gJ1NlcmlhbCcgb3IgJ1BhcmFsbGVsJy4gRGVmYXVsdHMgdG8gUGFyYWxsZWwuXG4gKiBAcGFyYW0ge1N0cmluZ30gW2pvYklkXSAtIEpvYiBJRCAoaWYgYWxyZWFkeSBhdmFpbGFibGUpXG4gKi9cbnZhciBKb2IgPSBmdW5jdGlvbihidWxrLCB0eXBlLCBvcGVyYXRpb24sIG9wdGlvbnMsIGpvYklkKSB7XG4gIHRoaXMuX2J1bGsgPSBidWxrO1xuICB0aGlzLnR5cGUgPSB0eXBlO1xuICB0aGlzLm9wZXJhdGlvbiA9IG9wZXJhdGlvbjtcbiAgdGhpcy5vcHRpb25zID0gb3B0aW9ucyB8fCB7fTtcbiAgdGhpcy5pZCA9IGpvYklkO1xuICB0aGlzLnN0YXRlID0gdGhpcy5pZCA/ICdPcGVuJyA6ICdVbmtub3duJztcbiAgdGhpcy5fYmF0Y2hlcyA9IHt9O1xufTtcblxuaW5oZXJpdHMoSm9iLCBldmVudHMuRXZlbnRFbWl0dGVyKTtcblxuLyoqXG4gKiBAdHlwZWRlZiB7T2JqZWN0fSBCdWxrfkpvYkluZm9cbiAqIEBwcm9wIHtTdHJpbmd9IGlkIC0gSm9iIElEXG4gKiBAcHJvcCB7U3RyaW5nfSBvYmplY3QgLSBPYmplY3QgdHlwZSBuYW1lXG4gKiBAcHJvcCB7U3RyaW5nfSBvcGVyYXRpb24gLSBPcGVyYXRpb24gdHlwZSBvZiB0aGUgam9iXG4gKiBAcHJvcCB7U3RyaW5nfSBzdGF0ZSAtIEpvYiBzdGF0dXNcbiAqL1xuXG4vKipcbiAqIFJldHVybiBsYXRlc3Qgam9iSW5mbyBmcm9tIGNhY2hlXG4gKlxuICogQG1ldGhvZCBCdWxrfkpvYiNpbmZvXG4gKiBAcGFyYW0ge0NhbGxiYWNrLjxCdWxrfkpvYkluZm8+fSBbY2FsbGJhY2tdIC0gQ2FsbGJhY2sgZnVuY3Rpb25cbiAqIEByZXR1cm5zIHtQcm9taXNlLjxCdWxrfkpvYkluZm8+fVxuICovXG5Kb2IucHJvdG90eXBlLmluZm8gPSBmdW5jdGlvbihjYWxsYmFjaykge1xuICB2YXIgc2VsZiA9IHRoaXM7XG4gIC8vIGlmIGNhY2hlIGlzIG5vdCBhdmFpbGFibGUsIGNoZWNrIHRoZSBsYXRlc3RcbiAgaWYgKCF0aGlzLl9qb2JJbmZvKSB7XG4gICAgdGhpcy5fam9iSW5mbyA9IHRoaXMuY2hlY2soKTtcbiAgfSBlbHNlIGlmIChzZWxmLm9wdGlvbnMucGtDaHVua2luZykge1xuICAgIHJldHVybiB0aGlzLl9qb2JJbmZvLnRoZW4oKGluZm8pID0+IHtcbiAgICAgIGlmIChpbmZvLm51bWJlckJhdGNoZXNUb3RhbCAhPT0gJzAnICYmIGluZm8ubnVtYmVyQmF0Y2hlc1RvdGFsID09PSBpbmZvLm51bWJlckJhdGNoZXNDb21wbGV0ZWQpIHtcbiAgICAgICAgc2VsZi5fam9iSW5mbyA9IFByb21pc2UucmVzb2x2ZShpbmZvKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHNlbGYuX2pvYkluZm8gPSBzZWxmLmNoZWNrKCk7XG4gICAgICB9XG4gICAgICByZXR1cm4gc2VsZi5fam9iSW5mby50aGVuQ2FsbChjYWxsYmFjayk7XG4gICAgfSlcbiAgfVxuXG4gIHJldHVybiB0aGlzLl9qb2JJbmZvLnRoZW5DYWxsKGNhbGxiYWNrKTtcbn07XG5cbi8qKlxuICogT3BlbiBuZXcgam9iIGFuZCBnZXQgam9iaW5mb1xuICpcbiAqIEBtZXRob2QgQnVsa35Kb2Ijb3BlblxuICogQHBhcmFtIHtDYWxsYmFjay48QnVsa35Kb2JJbmZvPn0gW2NhbGxiYWNrXSAtIENhbGxiYWNrIGZ1bmN0aW9uXG4gKiBAcmV0dXJucyB7UHJvbWlzZS48QnVsa35Kb2JJbmZvPn1cbiAqL1xuSm9iLnByb3RvdHlwZS5vcGVuID0gZnVuY3Rpb24oY2FsbGJhY2spIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuICB2YXIgYnVsayA9IHRoaXMuX2J1bGs7XG4gIHZhciBsb2dnZXIgPSBidWxrLl9sb2dnZXI7XG5cbiAgLy8gaWYgbm90IHJlcXVlc3RlZCBvcGVuaW5nIGpvYlxuICBpZiAoIXRoaXMuX2pvYkluZm8pIHtcbiAgICB2YXIgb3BlcmF0aW9uID0gdGhpcy5vcGVyYXRpb24udG9Mb3dlckNhc2UoKTtcbiAgICBpZiAob3BlcmF0aW9uID09PSAnaGFyZGRlbGV0ZScpIHsgb3BlcmF0aW9uID0gJ2hhcmREZWxldGUnOyB9XG4gICAgdmFyIGJvZHkgPSBbXG4gICAgICAnPD94bWwgdmVyc2lvbj1cIjEuMFwiIGVuY29kaW5nPVwiVVRGLThcIj8+JyxcbiAgICAgICc8am9iSW5mbyAgeG1sbnM9XCJodHRwOi8vd3d3LmZvcmNlLmNvbS8yMDA5LzA2L2FzeW5jYXBpL2RhdGFsb2FkXCI+JyxcbiAgICAgICAgJzxvcGVyYXRpb24+JyArIG9wZXJhdGlvbiArICc8L29wZXJhdGlvbj4nLFxuICAgICAgICAnPG9iamVjdD4nICsgdGhpcy50eXBlICsgJzwvb2JqZWN0PicsXG4gICAgICAgICh0aGlzLm9wdGlvbnMuZXh0SWRGaWVsZCA/XG4gICAgICAgICAnPGV4dGVybmFsSWRGaWVsZE5hbWU+Jyt0aGlzLm9wdGlvbnMuZXh0SWRGaWVsZCsnPC9leHRlcm5hbElkRmllbGROYW1lPicgOlxuICAgICAgICAgJycpLFxuICAgICAgICAodGhpcy5vcHRpb25zLmNvbmN1cnJlbmN5TW9kZSA/XG4gICAgICAgICAnPGNvbmN1cnJlbmN5TW9kZT4nK3RoaXMub3B0aW9ucy5jb25jdXJyZW5jeU1vZGUrJzwvY29uY3VycmVuY3lNb2RlPicgOlxuICAgICAgICAgJycpLFxuICAgICAgICAodGhpcy5vcHRpb25zLmFzc2lnbm1lbnRSdWxlSWQgP1xuICAgICAgICAgICc8YXNzaWdubWVudFJ1bGVJZD4nICsgdGhpcy5vcHRpb25zLmFzc2lnbm1lbnRSdWxlSWQgKyAnPC9hc3NpZ25tZW50UnVsZUlkPicgOlxuICAgICAgICAgICcnKSxcbiAgICAgICAgJzxjb250ZW50VHlwZT5DU1Y8L2NvbnRlbnRUeXBlPicsXG4gICAgICAnPC9qb2JJbmZvPidcbiAgICBdLmpvaW4oJycpO1xuXG4gICAgdmFyIGhlYWRlcnMgPSB7XG4gICAgICAnQ29udGVudC1UeXBlJyA6ICdhcHBsaWNhdGlvbi94bWw7IGNoYXJzZXQ9dXRmLTgnXG4gICAgfTtcbiAgICB2YXIgcGtDaHVua2luZyA9IHRoaXMub3B0aW9ucy5wa0NodW5raW5nO1xuICAgIGlmKHBrQ2h1bmtpbmcpIHtcbiAgICAgIHZhciBjaHVua2luZ1BhcmFtcyA9IE9iamVjdC5rZXlzKHBrQ2h1bmtpbmcpXG4gICAgICAgIC5maWx0ZXIoZnVuY3Rpb24oa2V5KSB7XG4gICAgICAgICAgcmV0dXJuIFsnY2h1bmtTaXplJywgJ3BhcmVudCcsICdzdGFydFJvdyddLmluZGV4T2Yoa2V5KSA+PSAwO1xuICAgICAgICB9KVxuICAgICAgICAubWFwKGZ1bmN0aW9uKGtleSkge1xuICAgICAgICAgIHJldHVybiBrZXkgKyAnPScgKyBwa0NodW5raW5nW2tleV07XG4gICAgICAgIH0pO1xuICAgICAgaWYoY2h1bmtpbmdQYXJhbXMubGVuZ3RoKVxuICAgICAgICBoZWFkZXJzWydTZm9yY2UtRW5hYmxlLVBLQ2h1bmtpbmcnXSA9IGNodW5raW5nUGFyYW1zLmpvaW4oJzsgJyk7XG4gICAgfVxuXG4gICAgdGhpcy5fam9iSW5mbyA9IGJ1bGsuX3JlcXVlc3Qoe1xuICAgICAgbWV0aG9kIDogJ1BPU1QnLFxuICAgICAgcGF0aCA6IFwiL2pvYlwiLFxuICAgICAgYm9keSA6IGJvZHksXG4gICAgICBoZWFkZXJzIDogaGVhZGVycyxcbiAgICAgIHJlc3BvbnNlVHlwZTogXCJhcHBsaWNhdGlvbi94bWxcIlxuICAgIH0pLnRoZW4oZnVuY3Rpb24ocmVzKSB7XG4gICAgICBzZWxmLmVtaXQoXCJvcGVuXCIsIHJlcy5qb2JJbmZvKTtcbiAgICAgIHNlbGYuaWQgPSByZXMuam9iSW5mby5pZDtcbiAgICAgIHNlbGYuc3RhdGUgPSByZXMuam9iSW5mby5zdGF0ZTtcbiAgICAgIHJldHVybiByZXMuam9iSW5mbztcbiAgICB9LCBmdW5jdGlvbihlcnIpIHtcbiAgICAgIHNlbGYuZW1pdChcImVycm9yXCIsIGVycik7XG4gICAgICB0aHJvdyBlcnI7XG4gICAgfSk7XG4gIH1cbiAgcmV0dXJuIHRoaXMuX2pvYkluZm8udGhlbkNhbGwoY2FsbGJhY2spO1xufTtcblxuLyoqXG4gKiBDcmVhdGUgYSBuZXcgYmF0Y2ggaW5zdGFuY2UgaW4gdGhlIGpvYlxuICpcbiAqIEBtZXRob2QgQnVsa35Kb2IjY3JlYXRlQmF0Y2hcbiAqIEByZXR1cm5zIHtCdWxrfkJhdGNofVxuICovXG5Kb2IucHJvdG90eXBlLmNyZWF0ZUJhdGNoID0gZnVuY3Rpb24oKSB7XG4gIHZhciBiYXRjaCA9IG5ldyBCYXRjaCh0aGlzKTtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuICBiYXRjaC5vbigncXVldWUnLCBmdW5jdGlvbigpIHtcbiAgICBzZWxmLl9iYXRjaGVzW2JhdGNoLmlkXSA9IGJhdGNoO1xuICB9KTtcbiAgcmV0dXJuIGJhdGNoO1xufTtcblxuLyoqXG4gKiBHZXQgYSBiYXRjaCBpbnN0YW5jZSBzcGVjaWZpZWQgYnkgZ2l2ZW4gYmF0Y2ggSURcbiAqXG4gKiBAbWV0aG9kIEJ1bGt+Sm9iI2JhdGNoXG4gKiBAcGFyYW0ge1N0cmluZ30gYmF0Y2hJZCAtIEJhdGNoIElEXG4gKiBAcmV0dXJucyB7QnVsa35CYXRjaH1cbiAqL1xuSm9iLnByb3RvdHlwZS5iYXRjaCA9IGZ1bmN0aW9uKGJhdGNoSWQpIHtcbiAgdmFyIGJhdGNoID0gdGhpcy5fYmF0Y2hlc1tiYXRjaElkXTtcbiAgaWYgKCFiYXRjaCkge1xuICAgIGJhdGNoID0gbmV3IEJhdGNoKHRoaXMsIGJhdGNoSWQpO1xuICAgIHRoaXMuX2JhdGNoZXNbYmF0Y2hJZF0gPSBiYXRjaDtcbiAgfVxuICByZXR1cm4gYmF0Y2g7XG59O1xuXG4vKipcbiAqIENoZWNrIHRoZSBsYXRlc3Qgam9iIHN0YXR1cyBmcm9tIHNlcnZlclxuICpcbiAqIEBtZXRob2QgQnVsa35Kb2IjY2hlY2tcbiAqIEBwYXJhbSB7Q2FsbGJhY2suPEJ1bGt+Sm9iSW5mbz59IFtjYWxsYmFja10gLSBDYWxsYmFjayBmdW5jdGlvblxuICogQHJldHVybnMge1Byb21pc2UuPEJ1bGt+Sm9iSW5mbz59XG4gKi9cbkpvYi5wcm90b3R5cGUuY2hlY2sgPSBmdW5jdGlvbihjYWxsYmFjaykge1xuICB2YXIgc2VsZiA9IHRoaXM7XG4gIHZhciBidWxrID0gdGhpcy5fYnVsaztcbiAgdmFyIGxvZ2dlciA9IGJ1bGsuX2xvZ2dlcjtcblxuICB0aGlzLl9qb2JJbmZvID0gdGhpcy5fd2FpdEFzc2lnbigpLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIGJ1bGsuX3JlcXVlc3Qoe1xuICAgICAgbWV0aG9kIDogJ0dFVCcsXG4gICAgICBwYXRoIDogXCIvam9iL1wiICsgc2VsZi5pZCxcbiAgICAgIHJlc3BvbnNlVHlwZTogXCJhcHBsaWNhdGlvbi94bWxcIlxuICAgIH0pO1xuICB9KS50aGVuKGZ1bmN0aW9uKHJlcykge1xuICAgIGxvZ2dlci5kZWJ1ZyhyZXMuam9iSW5mbyk7XG4gICAgc2VsZi5pZCA9IHJlcy5qb2JJbmZvLmlkO1xuICAgIHNlbGYudHlwZSA9IHJlcy5qb2JJbmZvLm9iamVjdDtcbiAgICBzZWxmLm9wZXJhdGlvbiA9IHJlcy5qb2JJbmZvLm9wZXJhdGlvbjtcbiAgICBzZWxmLnN0YXRlID0gcmVzLmpvYkluZm8uc3RhdGU7XG4gICAgcmV0dXJuIHJlcy5qb2JJbmZvO1xuICB9KTtcbiAgcmV0dXJuIHRoaXMuX2pvYkluZm8udGhlbkNhbGwoY2FsbGJhY2spO1xufTtcblxuLyoqXG4gKiBXYWl0IHRpbGwgdGhlIGpvYiBpcyBhc3NpZ25lZCB0byBzZXJ2ZXJcbiAqXG4gKiBAbWV0aG9kIEJ1bGt+Sm9iI2luZm9cbiAqIEBwYXJhbSB7Q2FsbGJhY2suPEJ1bGt+Sm9iSW5mbz59IFtjYWxsYmFja10gLSBDYWxsYmFjayBmdW5jdGlvblxuICogQHJldHVybnMge1Byb21pc2UuPEJ1bGt+Sm9iSW5mbz59XG4gKi9cbkpvYi5wcm90b3R5cGUuX3dhaXRBc3NpZ24gPSBmdW5jdGlvbihjYWxsYmFjaykge1xuICByZXR1cm4gKHRoaXMuaWQgPyBQcm9taXNlLnJlc29sdmUoeyBpZDogdGhpcy5pZCB9KSA6IHRoaXMub3BlbigpKS50aGVuQ2FsbChjYWxsYmFjayk7XG59O1xuXG5cbi8qKlxuICogTGlzdCBhbGwgcmVnaXN0ZXJlZCBiYXRjaCBpbmZvIGluIGpvYlxuICpcbiAqIEBtZXRob2QgQnVsa35Kb2IjbGlzdFxuICogQHBhcmFtIHtDYWxsYmFjay48QXJyYXkuPEJ1bGt+QmF0Y2hJbmZvPj59IFtjYWxsYmFja10gLSBDYWxsYmFjayBmdW5jdGlvblxuICogQHJldHVybnMge1Byb21pc2UuPEFycmF5LjxCdWxrfkJhdGNoSW5mbz4+fVxuICovXG5Kb2IucHJvdG90eXBlLmxpc3QgPSBmdW5jdGlvbihjYWxsYmFjaykge1xuICB2YXIgc2VsZiA9IHRoaXM7XG4gIHZhciBidWxrID0gdGhpcy5fYnVsaztcbiAgdmFyIGxvZ2dlciA9IGJ1bGsuX2xvZ2dlcjtcblxuICByZXR1cm4gdGhpcy5fd2FpdEFzc2lnbigpLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIGJ1bGsuX3JlcXVlc3Qoe1xuICAgICAgbWV0aG9kIDogJ0dFVCcsXG4gICAgICBwYXRoIDogXCIvam9iL1wiICsgc2VsZi5pZCArIFwiL2JhdGNoXCIsXG4gICAgICByZXNwb25zZVR5cGU6IFwiYXBwbGljYXRpb24veG1sXCJcbiAgICB9KTtcbiAgfSkudGhlbihmdW5jdGlvbihyZXMpIHtcbiAgICBsb2dnZXIuZGVidWcocmVzLmJhdGNoSW5mb0xpc3QuYmF0Y2hJbmZvKTtcbiAgICB2YXIgYmF0Y2hJbmZvTGlzdCA9IHJlcy5iYXRjaEluZm9MaXN0O1xuICAgIGJhdGNoSW5mb0xpc3QgPSBfLmlzQXJyYXkoYmF0Y2hJbmZvTGlzdC5iYXRjaEluZm8pID8gYmF0Y2hJbmZvTGlzdC5iYXRjaEluZm8gOiBbIGJhdGNoSW5mb0xpc3QuYmF0Y2hJbmZvIF07XG4gICAgcmV0dXJuIGJhdGNoSW5mb0xpc3Q7XG4gIH0pLnRoZW5DYWxsKGNhbGxiYWNrKTtcbn07XG5cbkpvYi5wcm90b3R5cGUucmV0cmlldmVCYXRjaGVzID0gZnVuY3Rpb24oY2FsbGJhY2spIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuXG4gIHJldHVybiBzZWxmLmxpc3QoKS50aGVuKChiYXRjaEluZm9MaXN0KSA9PiB7XG4gICAgcmV0dXJuIFByb21pc2UuYWxsKGJhdGNoSW5mb0xpc3QubWFwKGZ1bmN0aW9uKGJhdGNoSW5mbykge1xuICAgICAgaWYgKGJhdGNoSW5mby5zdGF0ZSA9PT0gJ05vdFByb2Nlc3NlZCcgfHwgcGFyc2VJbnQoYmF0Y2hJbmZvLm51bWJlclJlY29yZHNQcm9jZXNzZWQsIDEwKSA9PT0gMCkgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgaWYgKGJhdGNoSW5mby5zdGF0ZSA9PT0gJ0ZhaWxlZCcgJiYgcGFyc2VJbnQoYmF0Y2hJbmZvLm51bWJlclJlY29yZHNQcm9jZXNzZWQsIDEwKSA9PT0gMCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYmF0Y2hJbmZvLnN0YXRlTWVzc2FnZSlcbiAgICAgIH1cbiAgICAgIHJldHVybiBzZWxmLmJhdGNoKGJhdGNoSW5mby5pZCkucmV0cmlldmUoKTtcbiAgICB9KSk7XG4gIH0pLnRoZW4oZnVuY3Rpb24oYmF0Y2hSZXN1bHRzKSB7XG4gICAgY29uc3QgcmVzdWx0cyA9IFtdO1xuICAgIGJhdGNoUmVzdWx0cy5mb3JFYWNoKGZ1bmN0aW9uKGJhdGNoUmVzdWx0KSB7XG4gICAgICBpZiAoIWJhdGNoUmVzdWx0KSByZXR1cm47XG4gICAgICByZXN1bHRzLnB1c2goLi4uYmF0Y2hSZXN1bHQpO1xuICAgIH0pO1xuICAgIHJldHVybiByZXN1bHRzO1xuICB9KS50aGVuKGZ1bmN0aW9uKHJlc3VsdHMpIHtcbiAgICByZXR1cm4gc2VsZi5jbG9zZSgpLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgICByZXR1cm4gcmVzdWx0cztcbiAgICB9KVxuICB9KS5mYWlsKGZ1bmN0aW9uKGVycikge1xuICAgIHNlbGYuZW1pdChcImVycm9yXCIsIGVycik7XG4gICAgcmV0dXJuIHNlbGYuYWJvcnQoKS50aGVuKCgpID0+IHtcbiAgICAgIHRocm93IGVycjtcbiAgICB9KTtcbiAgfSkudGhlbkNhbGwoY2FsbGJhY2spO1xufVxuXG4vKipcbiAqIENsb3NlIG9wZW5lZCBqb2JcbiAqXG4gKiBAbWV0aG9kIEJ1bGt+Sm9iI2Nsb3NlXG4gKiBAcGFyYW0ge0NhbGxiYWNrLjxCdWxrfkpvYkluZm8+fSBbY2FsbGJhY2tdIC0gQ2FsbGJhY2sgZnVuY3Rpb25cbiAqIEByZXR1cm5zIHtQcm9taXNlLjxCdWxrfkpvYkluZm8+fVxuICovXG5Kb2IucHJvdG90eXBlLmNsb3NlID0gZnVuY3Rpb24oKSB7XG4gIHZhciBzZWxmID0gdGhpcztcbiAgcmV0dXJuIHRoaXMuX2NoYW5nZVN0YXRlKFwiQ2xvc2VkXCIpLnRoZW4oZnVuY3Rpb24oam9iSW5mbykge1xuICAgIHNlbGYuaWQgPSBudWxsO1xuICAgIHNlbGYuZW1pdChcImNsb3NlXCIsIGpvYkluZm8pO1xuICAgIHJldHVybiBqb2JJbmZvO1xuICB9LCBmdW5jdGlvbihlcnIpIHtcbiAgICBzZWxmLmVtaXQoXCJlcnJvclwiLCBlcnIpO1xuICAgIHRocm93IGVycjtcbiAgfSk7XG59O1xuXG4vKipcbiAqIFNldCB0aGUgc3RhdHVzIHRvIGFib3J0XG4gKlxuICogQG1ldGhvZCBCdWxrfkpvYiNhYm9ydFxuICogQHBhcmFtIHtDYWxsYmFjay48QnVsa35Kb2JJbmZvPn0gW2NhbGxiYWNrXSAtIENhbGxiYWNrIGZ1bmN0aW9uXG4gKiBAcmV0dXJucyB7UHJvbWlzZS48QnVsa35Kb2JJbmZvPn1cbiAqL1xuSm9iLnByb3RvdHlwZS5hYm9ydCA9IGZ1bmN0aW9uKCkge1xuICB2YXIgc2VsZiA9IHRoaXM7XG4gIHJldHVybiB0aGlzLl9jaGFuZ2VTdGF0ZShcIkFib3J0ZWRcIikudGhlbihmdW5jdGlvbihqb2JJbmZvKSB7XG4gICAgc2VsZi5pZCA9IG51bGw7XG4gICAgc2VsZi5lbWl0KFwiYWJvcnRcIiwgam9iSW5mbyk7XG4gICAgcmV0dXJuIGpvYkluZm87XG4gIH0sIGZ1bmN0aW9uKGVycikge1xuICAgIHNlbGYuZW1pdChcImVycm9yXCIsIGVycik7XG4gICAgdGhyb3cgZXJyO1xuICB9KTtcbn07XG5cbi8qKlxuICogQHByaXZhdGVcbiAqL1xuSm9iLnByb3RvdHlwZS5fY2hhbmdlU3RhdGUgPSBmdW5jdGlvbihzdGF0ZSwgY2FsbGJhY2spIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuICB2YXIgYnVsayA9IHRoaXMuX2J1bGs7XG4gIHZhciBsb2dnZXIgPSBidWxrLl9sb2dnZXI7XG5cbiAgdGhpcy5fam9iSW5mbyA9IHRoaXMuX3dhaXRBc3NpZ24oKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgIHZhciBib2R5ID0gW1xuICAgICAgJzw/eG1sIHZlcnNpb249XCIxLjBcIiBlbmNvZGluZz1cIlVURi04XCI/PicsXG4gICAgICAnPGpvYkluZm8geG1sbnM9XCJodHRwOi8vd3d3LmZvcmNlLmNvbS8yMDA5LzA2L2FzeW5jYXBpL2RhdGFsb2FkXCI+JyxcbiAgICAgICAgJzxzdGF0ZT4nICsgc3RhdGUgKyAnPC9zdGF0ZT4nLFxuICAgICAgJzwvam9iSW5mbz4nXG4gICAgXS5qb2luKCcnKTtcbiAgICByZXR1cm4gYnVsay5fcmVxdWVzdCh7XG4gICAgICBtZXRob2QgOiAnUE9TVCcsXG4gICAgICBwYXRoIDogXCIvam9iL1wiICsgc2VsZi5pZCxcbiAgICAgIGJvZHkgOiBib2R5LFxuICAgICAgaGVhZGVycyA6IHtcbiAgICAgICAgXCJDb250ZW50LVR5cGVcIiA6IFwiYXBwbGljYXRpb24veG1sOyBjaGFyc2V0PXV0Zi04XCJcbiAgICAgIH0sXG4gICAgICByZXNwb25zZVR5cGU6IFwiYXBwbGljYXRpb24veG1sXCJcbiAgICB9KTtcbiAgfSkudGhlbihmdW5jdGlvbihyZXMpIHtcbiAgICBsb2dnZXIuZGVidWcocmVzLmpvYkluZm8pO1xuICAgIHNlbGYuc3RhdGUgPSByZXMuam9iSW5mby5zdGF0ZTtcbiAgICByZXR1cm4gcmVzLmpvYkluZm87XG4gIH0pO1xuICByZXR1cm4gdGhpcy5fam9iSW5mby50aGVuQ2FsbChjYWxsYmFjayk7XG5cbn07XG5cblxuLyotLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSovXG5cbi8qKlxuICogQmF0Y2ggKGV4dGVuZHMgUmVjb3JkU3RyZWFtKVxuICpcbiAqIEBwcm90ZWN0ZWRcbiAqIEBjbGFzcyBCdWxrfkJhdGNoXG4gKiBAZXh0ZW5kcyB7c3RyZWFtLldyaXRhYmxlfVxuICogQGltcGxlbWVudHMge1Byb21pc2UuPEFycmF5LjxSZWNvcmRSZXN1bHQ+Pn1cbiAqIEBwYXJhbSB7QnVsa35Kb2J9IGpvYiAtIEJ1bGsgam9iIG9iamVjdFxuICogQHBhcmFtIHtTdHJpbmd9IFtiYXRjaElkXSAtIEJhdGNoIElEIChpZiBhbHJlYWR5IGF2YWlsYWJsZSlcbiAqL1xudmFyIEJhdGNoID0gZnVuY3Rpb24oam9iLCBiYXRjaElkKSB7XG4gIEJhdGNoLnN1cGVyXy5jYWxsKHRoaXMsIHsgb2JqZWN0TW9kZTogdHJ1ZSB9KTtcbiAgdGhpcy5qb2IgPSBqb2I7XG4gIHRoaXMuaWQgPSBiYXRjaElkO1xuICB0aGlzLl9idWxrID0gam9iLl9idWxrO1xuICB0aGlzLl9kZWZlcnJlZCA9IFByb21pc2UuZGVmZXIoKTtcbiAgdGhpcy5fc2V0dXBEYXRhU3RyZWFtcygpO1xufTtcblxuaW5oZXJpdHMoQmF0Y2gsIHN0cmVhbS5Xcml0YWJsZSk7XG5cblxuLyoqXG4gKiBAcHJpdmF0ZVxuICovXG5CYXRjaC5wcm90b3R5cGUuX3NldHVwRGF0YVN0cmVhbXMgPSBmdW5jdGlvbigpIHtcbiAgdmFyIGJhdGNoID0gdGhpcztcbiAgdmFyIGNvbnZlcnRlck9wdGlvbnMgPSB7IG51bGxWYWx1ZSA6ICcjTi9BJyB9O1xuICB0aGlzLl91cGxvYWRTdHJlYW0gPSBuZXcgUmVjb3JkU3RyZWFtLlNlcmlhbGl6YWJsZSgpO1xuICB0aGlzLl91cGxvYWREYXRhU3RyZWFtID0gdGhpcy5fdXBsb2FkU3RyZWFtLnN0cmVhbSgnY3N2JywgY29udmVydGVyT3B0aW9ucyk7XG4gIHRoaXMuX2Rvd25sb2FkU3RyZWFtID0gbmV3IFJlY29yZFN0cmVhbS5QYXJzYWJsZSgpO1xuICB0aGlzLl9kb3dubG9hZERhdGFTdHJlYW0gPSB0aGlzLl9kb3dubG9hZFN0cmVhbS5zdHJlYW0oJ2NzdicsIGNvbnZlcnRlck9wdGlvbnMpO1xuXG4gIHRoaXMub24oJ2ZpbmlzaCcsIGZ1bmN0aW9uKCkge1xuICAgIGJhdGNoLl91cGxvYWRTdHJlYW0uZW5kKCk7XG4gIH0pO1xuICB0aGlzLl91cGxvYWREYXRhU3RyZWFtLm9uY2UoJ3JlYWRhYmxlJywgZnVuY3Rpb24oKSB7XG4gICAgYmF0Y2guam9iLm9wZW4oKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgICAgLy8gcGlwZSB1cGxvYWQgZGF0YSB0byBiYXRjaCBBUEkgcmVxdWVzdCBzdHJlYW1cbiAgICAgIGJhdGNoLl91cGxvYWREYXRhU3RyZWFtLnBpcGUoYmF0Y2guX2NyZWF0ZVJlcXVlc3RTdHJlYW0oKSk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIC8vIGR1cGxleCBkYXRhIHN0cmVhbSwgb3BlbmVkIGFjY2VzcyB0byBBUEkgcHJvZ3JhbW1lcnMgYnkgQmF0Y2gjc3RyZWFtKClcbiAgdmFyIGRhdGFTdHJlYW0gPSB0aGlzLl9kYXRhU3RyZWFtID0gbmV3IER1cGxleCgpO1xuICBkYXRhU3RyZWFtLl93cml0ZSA9IGZ1bmN0aW9uKGRhdGEsIGVuYywgY2IpIHtcbiAgICBiYXRjaC5fdXBsb2FkRGF0YVN0cmVhbS53cml0ZShkYXRhLCBlbmMsIGNiKTtcbiAgfTtcbiAgZGF0YVN0cmVhbS5vbignZmluaXNoJywgZnVuY3Rpb24oKSB7XG4gICAgYmF0Y2guX3VwbG9hZERhdGFTdHJlYW0uZW5kKCk7XG4gIH0pO1xuXG4gIHRoaXMuX2Rvd25sb2FkRGF0YVN0cmVhbS5vbigncmVhZGFibGUnLCBmdW5jdGlvbigpIHtcbiAgICBkYXRhU3RyZWFtLnJlYWQoMCk7XG4gIH0pO1xuICB0aGlzLl9kb3dubG9hZERhdGFTdHJlYW0ub24oJ2VuZCcsIGZ1bmN0aW9uKCkge1xuICAgIGRhdGFTdHJlYW0ucHVzaChudWxsKTtcbiAgfSk7XG4gIGRhdGFTdHJlYW0uX3JlYWQgPSBmdW5jdGlvbihzaXplKSB7XG4gICAgdmFyIGNodW5rO1xuICAgIHdoaWxlICgoY2h1bmsgPSBiYXRjaC5fZG93bmxvYWREYXRhU3RyZWFtLnJlYWQoKSkgIT09IG51bGwpIHtcbiAgICAgIGRhdGFTdHJlYW0ucHVzaChjaHVuayk7XG4gICAgfVxuICB9O1xufTtcblxuLyoqXG4gKiBDb25uZWN0IGJhdGNoIEFQSSBhbmQgY3JlYXRlIHN0cmVhbSBpbnN0YW5jZSBvZiByZXF1ZXN0L3Jlc3BvbnNlXG4gKlxuICogQHByaXZhdGVcbiAqIEByZXR1cm5zIHtzdHJlYW0uRHVwbGV4fVxuICovXG5CYXRjaC5wcm90b3R5cGUuX2NyZWF0ZVJlcXVlc3RTdHJlYW0gPSBmdW5jdGlvbigpIHtcbiAgdmFyIGJhdGNoID0gdGhpcztcbiAgdmFyIGJ1bGsgPSBiYXRjaC5fYnVsaztcbiAgdmFyIGxvZ2dlciA9IGJ1bGsuX2xvZ2dlcjtcblxuICByZXR1cm4gYnVsay5fcmVxdWVzdCh7XG4gICAgbWV0aG9kIDogJ1BPU1QnLFxuICAgIHBhdGggOiBcIi9qb2IvXCIgKyBiYXRjaC5qb2IuaWQgKyBcIi9iYXRjaFwiLFxuICAgIGhlYWRlcnM6IHtcbiAgICAgIFwiQ29udGVudC1UeXBlXCI6IFwidGV4dC9jc3ZcIlxuICAgIH0sXG4gICAgcmVzcG9uc2VUeXBlOiBcImFwcGxpY2F0aW9uL3htbFwiXG4gIH0sIGZ1bmN0aW9uKGVyciwgcmVzKSB7XG4gICAgaWYgKGVycikge1xuICAgICAgYmF0Y2guZW1pdCgnZXJyb3InLCBlcnIpO1xuICAgIH0gZWxzZSB7XG4gICAgICBsb2dnZXIuZGVidWcocmVzLmJhdGNoSW5mbyk7XG4gICAgICBiYXRjaC5pZCA9IHJlcy5iYXRjaEluZm8uaWQ7XG4gICAgICBiYXRjaC5lbWl0KCdxdWV1ZScsIHJlcy5iYXRjaEluZm8pO1xuICAgIH1cbiAgfSkuc3RyZWFtKCk7XG59O1xuXG4vKipcbiAqIEltcGxlbWVudGF0aW9uIG9mIFdyaXRhYmxlXG4gKlxuICogQG92ZXJyaWRlXG4gKiBAcHJpdmF0ZVxuICovXG5CYXRjaC5wcm90b3R5cGUuX3dyaXRlID0gZnVuY3Rpb24ocmVjb3JkLCBlbmMsIGNiKSB7XG4gIHJlY29yZCA9IF8uY2xvbmUocmVjb3JkKTtcbiAgaWYgKHRoaXMuam9iLm9wZXJhdGlvbiA9PT0gXCJpbnNlcnRcIikge1xuICAgIGRlbGV0ZSByZWNvcmQuSWQ7XG4gIH0gZWxzZSBpZiAodGhpcy5qb2Iub3BlcmF0aW9uID09PSBcImRlbGV0ZVwiKSB7XG4gICAgcmVjb3JkID0geyBJZDogcmVjb3JkLklkIH07XG4gIH1cbiAgZGVsZXRlIHJlY29yZC50eXBlO1xuICBkZWxldGUgcmVjb3JkLmF0dHJpYnV0ZXM7XG4gIHRoaXMuX3VwbG9hZFN0cmVhbS53cml0ZShyZWNvcmQsIGVuYywgY2IpO1xufTtcblxuLyoqXG4gKiBSZXR1cm5zIGR1cGxleCBzdHJlYW0gd2hpY2ggYWNjZXB0cyBDU1YgZGF0YSBpbnB1dCBhbmQgYmF0Y2ggcmVzdWx0IG91dHB1dFxuICpcbiAqIEByZXR1cm5zIHtzdHJlYW0uRHVwbGV4fVxuICovXG5CYXRjaC5wcm90b3R5cGUuc3RyZWFtID0gZnVuY3Rpb24oKSB7XG4gIHJldHVybiB0aGlzLl9kYXRhU3RyZWFtO1xufTtcblxuLyoqXG4gKiBFeGVjdXRlIGJhdGNoIG9wZXJhdGlvblxuICpcbiAqIEBtZXRob2QgQnVsa35CYXRjaCNleGVjdXRlXG4gKiBAcGFyYW0ge0FycmF5LjxSZWNvcmQ+fHN0cmVhbS5TdHJlYW18U3RyaW5nfSBbaW5wdXRdIC0gSW5wdXQgc291cmNlIGZvciBiYXRjaCBvcGVyYXRpb24uIEFjY2VwdHMgYXJyYXkgb2YgcmVjb3JkcywgQ1NWIHN0cmluZywgYW5kIENTViBkYXRhIGlucHV0IHN0cmVhbSBpbiBpbnNlcnQvdXBkYXRlL3Vwc2VydC9kZWxldGUvaGFyZERlbGV0ZSBvcGVyYXRpb24sIFNPUUwgc3RyaW5nIGluIHF1ZXJ5IG9wZXJhdGlvbi5cbiAqIEBwYXJhbSB7Q2FsbGJhY2suPEFycmF5LjxSZWNvcmRSZXN1bHQ+fEFycmF5LjxCYXRjaFJlc3VsdEluZm8+Pn0gW2NhbGxiYWNrXSAtIENhbGxiYWNrIGZ1bmN0aW9uXG4gKiBAcmV0dXJucyB7QnVsa35CYXRjaH1cbiAqL1xuQmF0Y2gucHJvdG90eXBlLnJ1biA9XG5CYXRjaC5wcm90b3R5cGUuZXhlYyA9XG5CYXRjaC5wcm90b3R5cGUuZXhlY3V0ZSA9IGZ1bmN0aW9uKGlucHV0LCBjYWxsYmFjaykge1xuICB2YXIgc2VsZiA9IHRoaXM7XG5cbiAgaWYgKHR5cGVvZiBpbnB1dCA9PT0gJ2Z1bmN0aW9uJykgeyAvLyBpZiBpbnB1dCBhcmd1bWVudCBpcyBvbWl0dGVkXG4gICAgY2FsbGJhY2sgPSBpbnB1dDtcbiAgICBpbnB1dCA9IG51bGw7XG4gIH1cblxuICAvLyBpZiBiYXRjaCBpcyBhbHJlYWR5IGV4ZWN1dGVkXG4gIGlmICh0aGlzLl9yZXN1bHQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJCYXRjaCBhbHJlYWR5IGV4ZWN1dGVkLlwiKTtcbiAgfVxuXG4gIHZhciByZGVmZXJyZWQgPSBQcm9taXNlLmRlZmVyKCk7XG4gIHRoaXMuX3Jlc3VsdCA9IHJkZWZlcnJlZC5wcm9taXNlO1xuICB0aGlzLl9yZXN1bHQudGhlbihmdW5jdGlvbihyZXMpIHtcbiAgICBzZWxmLl9kZWZlcnJlZC5yZXNvbHZlKHJlcyk7XG4gIH0sIGZ1bmN0aW9uKGVycikge1xuICAgIHNlbGYuX2RlZmVycmVkLnJlamVjdChlcnIpO1xuICB9KTtcbiAgdGhpcy5vbmNlKCdyZXNwb25zZScsIGZ1bmN0aW9uKHJlcykge1xuICAgIHJkZWZlcnJlZC5yZXNvbHZlKHJlcyk7XG4gIH0pO1xuICB0aGlzLm9uY2UoJ2Vycm9yJywgZnVuY3Rpb24oZXJyKSB7XG4gICAgcmRlZmVycmVkLnJlamVjdChlcnIpO1xuICB9KTtcblxuICBpZiAoXy5pc09iamVjdChpbnB1dCkgJiYgXy5pc0Z1bmN0aW9uKGlucHV0LnBpcGUpKSB7IC8vIGlmIGlucHV0IGhhcyBzdHJlYW0uUmVhZGFibGUgaW50ZXJmYWNlXG4gICAgaW5wdXQucGlwZSh0aGlzLl9kYXRhU3RyZWFtKTtcbiAgfSBlbHNlIHtcbiAgICB2YXIgZGF0YTtcbiAgICBpZiAoXy5pc0FycmF5KGlucHV0KSkge1xuICAgICAgXy5mb3JFYWNoKGlucHV0LCBmdW5jdGlvbihyZWNvcmQpIHtcbiAgICAgICAgT2JqZWN0LmtleXMocmVjb3JkKS5mb3JFYWNoKGZ1bmN0aW9uKGtleSkge1xuICAgICAgICAgIGlmICh0eXBlb2YgcmVjb3JkW2tleV0gPT09ICdib29sZWFuJykge1xuICAgICAgICAgICAgcmVjb3JkW2tleV0gPSBTdHJpbmcocmVjb3JkW2tleV0pXG4gICAgICAgICAgfVxuICAgICAgICB9KVxuICAgICAgICBzZWxmLndyaXRlKHJlY29yZCk7XG4gICAgICB9KTtcbiAgICAgIHNlbGYuZW5kKCk7XG4gICAgfSBlbHNlIGlmIChfLmlzU3RyaW5nKGlucHV0KSl7XG4gICAgICBkYXRhID0gaW5wdXQ7XG4gICAgICB0aGlzLl9kYXRhU3RyZWFtLndyaXRlKGRhdGEsICd1dGY4Jyk7XG4gICAgICB0aGlzLl9kYXRhU3RyZWFtLmVuZCgpO1xuICAgIH1cbiAgfVxuXG4gIC8vIHJldHVybiBCYXRjaCBpbnN0YW5jZSBmb3IgY2hhaW5pbmdcbiAgcmV0dXJuIHRoaXMudGhlbkNhbGwoY2FsbGJhY2spO1xufTtcblxuLyoqXG4gKiBQcm9taXNlL0ErIGludGVyZmFjZVxuICogaHR0cDovL3Byb21pc2VzLWFwbHVzLmdpdGh1Yi5pby9wcm9taXNlcy1zcGVjL1xuICpcbiAqIERlbGVnYXRlIHRvIGRlZmVycmVkIHByb21pc2UsIHJldHVybiBwcm9taXNlIGluc3RhbmNlIGZvciBiYXRjaCByZXN1bHRcbiAqXG4gKiBAbWV0aG9kIEJ1bGt+QmF0Y2gjdGhlblxuICovXG5CYXRjaC5wcm90b3R5cGUudGhlbiA9IGZ1bmN0aW9uKG9uUmVzb2x2ZWQsIG9uUmVqZWN0LCBvblByb2dyZXNzKSB7XG4gIHJldHVybiB0aGlzLl9kZWZlcnJlZC5wcm9taXNlLnRoZW4ob25SZXNvbHZlZCwgb25SZWplY3QsIG9uUHJvZ3Jlc3MpO1xufTtcblxuLyoqXG4gKiBQcm9taXNlL0ErIGV4dGVuc2lvblxuICogQ2FsbCBcInRoZW5cIiB1c2luZyBnaXZlbiBub2RlLXN0eWxlIGNhbGxiYWNrIGZ1bmN0aW9uXG4gKlxuICogQG1ldGhvZCBCdWxrfkJhdGNoI3RoZW5DYWxsXG4gKi9cbkJhdGNoLnByb3RvdHlwZS50aGVuQ2FsbCA9IGZ1bmN0aW9uKGNhbGxiYWNrKSB7XG4gIGlmIChfLmlzRnVuY3Rpb24oY2FsbGJhY2spKSB7XG4gICAgdGhpcy50aGVuKGZ1bmN0aW9uKHJlcykge1xuICAgICAgcHJvY2Vzcy5uZXh0VGljayhmdW5jdGlvbigpIHtcbiAgICAgICAgY2FsbGJhY2sobnVsbCwgcmVzKTtcbiAgICAgIH0pO1xuICAgIH0sIGZ1bmN0aW9uKGVycikge1xuICAgICAgcHJvY2Vzcy5uZXh0VGljayhmdW5jdGlvbigpIHtcbiAgICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9XG4gIHJldHVybiB0aGlzO1xufTtcblxuLyoqXG4gKiBAdHlwZWRlZiB7T2JqZWN0fSBCdWxrfkJhdGNoSW5mb1xuICogQHByb3Age1N0cmluZ30gaWQgLSBCYXRjaCBJRFxuICogQHByb3Age1N0cmluZ30gam9iSWQgLSBKb2IgSURcbiAqIEBwcm9wIHtTdHJpbmd9IHN0YXRlIC0gQmF0Y2ggc3RhdGVcbiAqIEBwcm9wIHtTdHJpbmd9IHN0YXRlTWVzc2FnZSAtIEJhdGNoIHN0YXRlIG1lc3NhZ2VcbiAqL1xuXG4vKipcbiAqIENoZWNrIHRoZSBsYXRlc3QgYmF0Y2ggc3RhdHVzIGluIHNlcnZlclxuICpcbiAqIEBtZXRob2QgQnVsa35CYXRjaCNjaGVja1xuICogQHBhcmFtIHtDYWxsYmFjay48QnVsa35CYXRjaEluZm8+fSBbY2FsbGJhY2tdIC0gQ2FsbGJhY2sgZnVuY3Rpb25cbiAqIEByZXR1cm5zIHtQcm9taXNlLjxCdWxrfkJhdGNoSW5mbz59XG4gKi9cbkJhdGNoLnByb3RvdHlwZS5jaGVjayA9IGZ1bmN0aW9uKGNhbGxiYWNrKSB7XG4gIHZhciBzZWxmID0gdGhpcztcbiAgdmFyIGJ1bGsgPSB0aGlzLl9idWxrO1xuICB2YXIgbG9nZ2VyID0gYnVsay5fbG9nZ2VyO1xuICB2YXIgam9iSWQgPSB0aGlzLmpvYi5pZDtcbiAgdmFyIGJhdGNoSWQgPSB0aGlzLmlkO1xuXG4gIGlmICgham9iSWQgfHwgIWJhdGNoSWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJCYXRjaCBub3Qgc3RhcnRlZC5cIik7XG4gIH1cblxuICByZXR1cm4gYnVsay5fcmVxdWVzdCh7XG4gICAgbWV0aG9kIDogJ0dFVCcsXG4gICAgcGF0aCA6IFwiL2pvYi9cIiArIGpvYklkICsgXCIvYmF0Y2gvXCIgKyBiYXRjaElkLFxuICAgIHJlc3BvbnNlVHlwZTogXCJhcHBsaWNhdGlvbi94bWxcIlxuICB9KS50aGVuKGZ1bmN0aW9uKHJlcykge1xuICAgIGxvZ2dlci5kZWJ1ZyhyZXMuYmF0Y2hJbmZvKTtcbiAgICByZXR1cm4gcmVzLmJhdGNoSW5mbztcbiAgfSkudGhlbkNhbGwoY2FsbGJhY2spO1xufTtcblxuXG4vKipcbiAqIFBvbGxpbmcgdGhlIGJhdGNoIHJlc3VsdCBhbmQgcmV0cmlldmVcbiAqXG4gKiBAbWV0aG9kIEJ1bGt+QmF0Y2gjcG9sbFxuICogQHBhcmFtIHtOdW1iZXJ9IGludGVydmFsIC0gUG9sbGluZyBpbnRlcnZhbCBpbiBtaWxsaXNlY29uZHNcbiAqIEBwYXJhbSB7TnVtYmVyfSB0aW1lb3V0IC0gUG9sbGluZyB0aW1lb3V0IGluIG1pbGxpc2Vjb25kc1xuICovXG5CYXRjaC5wcm90b3R5cGUucG9sbCA9IGZ1bmN0aW9uKGludGVydmFsLCB0aW1lb3V0KSB7XG4gIHZhciBzZWxmID0gdGhpcztcbiAgdmFyIGpvYiA9IHRoaXMuam9iO1xuICB2YXIgYmF0Y2hJZCA9IHRoaXMuaWQ7XG5cbiAgaWYgKCFqb2IuaWQgfHwgIWJhdGNoSWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJCYXRjaCBub3Qgc3RhcnRlZC5cIik7XG4gIH1cbiAgdmFyIHN0YXJ0VGltZSA9IG5ldyBEYXRlKCkuZ2V0VGltZSgpO1xuICB2YXIgcG9sbCA9IGZ1bmN0aW9uKCkge1xuICAgIHZhciBub3cgPSBuZXcgRGF0ZSgpLmdldFRpbWUoKTtcbiAgICBpZiAoc3RhcnRUaW1lICsgdGltZW91dCA8IG5vdykge1xuICAgICAgdmFyIGVyciA9IG5ldyBFcnJvcihcIlBvbGxpbmcgdGltZSBvdXQuIEpvYiBJZCA9IFwiICsgam9iLmlkICsgXCIgLCBiYXRjaCBJZCA9IFwiICsgYmF0Y2hJZCk7XG4gICAgICBlcnIubmFtZSA9ICdQb2xsaW5nVGltZW91dCc7XG4gICAgICBlcnIuam9iSWQgPSBqb2IuaWQ7XG4gICAgICBlcnIuYmF0Y2hJZCA9IGJhdGNoSWQ7XG4gICAgICBzZWxmLmVtaXQoJ2Vycm9yJywgZXJyKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgam9iLmluZm8oKS50aGVuKGZ1bmN0aW9uKGpvYkluZm8pIHtcbiAgICAgIHNlbGYuY2hlY2soZnVuY3Rpb24oZXJyLCByZXMpIHtcbiAgICAgICAgY29uc3QgYmF0Y2hlc0NvbXBsZXRlID0gam9iSW5mby5udW1iZXJCYXRjaGVzVG90YWwgIT09ICcwJyAmJiBqb2JJbmZvLm51bWJlckJhdGNoZXNUb3RhbCA9PT0gam9iSW5mby5udW1iZXJCYXRjaGVzQ29tcGxldGVkO1xuICAgICAgICBpZiAoZXJyKSB7XG4gICAgICAgICAgc2VsZi5lbWl0KCdlcnJvcicsIGVycik7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgaWYgKHJlcy5zdGF0ZSA9PT0gXCJGYWlsZWRcIikge1xuICAgICAgICAgICAgaWYgKHBhcnNlSW50KHJlcy5udW1iZXJSZWNvcmRzUHJvY2Vzc2VkLCAxMCkgPiAwKSB7XG4gICAgICAgICAgICAgIHNlbGYucmV0cmlldmUoKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIHNlbGYuZW1pdCgnZXJyb3InLCBuZXcgRXJyb3IocmVzLnN0YXRlTWVzc2FnZSkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gZWxzZSBpZiAocmVzLnN0YXRlID09PSBcIkNvbXBsZXRlZFwiKXtcbiAgICAgICAgICAgIHNlbGYucmV0cmlldmUoKTtcbiAgICAgICAgICB9IGVsc2UgaWYgKHJlcy5zdGF0ZSA9PT0gXCJOb3RQcm9jZXNzZWRcIiAmJiBiYXRjaGVzQ29tcGxldGUpIHtcbiAgICAgICAgICAgIGpvYi5yZXRyaWV2ZUJhdGNoZXMoKVxuICAgICAgICAgICAgICAudGhlbigocmVzdWx0cykgPT4ge1xuICAgICAgICAgICAgICAgIHNlbGYuZW1pdCgncmVzcG9uc2UnLCByZXN1bHRzKTtcbiAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgLmZhaWwoZnVuY3Rpb24oZXJyKSB7XG4gICAgICAgICAgICAgICAgc2VsZi5lbWl0KCdlcnJvcicsIGVycik7XG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzZWxmLmVtaXQoJ3Byb2dyZXNzJywgcmVzKTtcbiAgICAgICAgICAgIHNldFRpbWVvdXQocG9sbCwgaW50ZXJ2YWwpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgfSlcbiAgfTtcbiAgc2V0VGltZW91dChwb2xsLCBpbnRlcnZhbCk7XG59O1xuXG4vKipcbiAqIEB0eXBlZGVmIHtPYmplY3R9IEJ1bGt+QmF0Y2hSZXN1bHRJbmZvXG4gKiBAcHJvcCB7U3RyaW5nfSBpZCAtIEJhdGNoIHJlc3VsdCBJRFxuICogQHByb3Age1N0cmluZ30gYmF0Y2hJZCAtIEJhdGNoIElEIHdoaWNoIGluY2x1ZGVzIHRoaXMgYmF0Y2ggcmVzdWx0LlxuICogQHByb3Age1N0cmluZ30gam9iSWQgLSBKb2IgSUQgd2hpY2ggaW5jbHVkZXMgdGhpcyBiYXRjaCByZXN1bHQuXG4gKi9cblxuLyoqXG4gKiBSZXRyaWV2ZSBiYXRjaCByZXN1bHRcbiAqXG4gKiBAbWV0aG9kIEJ1bGt+QmF0Y2gjcmV0cmlldmVcbiAqIEBwYXJhbSB7Q2FsbGJhY2suPEFycmF5LjxSZWNvcmRSZXN1bHQ+fEFycmF5LjxCdWxrfkJhdGNoUmVzdWx0SW5mbz4+fSBbY2FsbGJhY2tdIC0gQ2FsbGJhY2sgZnVuY3Rpb25cbiAqIEByZXR1cm5zIHtQcm9taXNlLjxBcnJheS48UmVjb3JkUmVzdWx0PnxBcnJheS48QnVsa35CYXRjaFJlc3VsdEluZm8+Pn1cbiAqL1xuQmF0Y2gucHJvdG90eXBlLnJldHJpZXZlID0gZnVuY3Rpb24oY2FsbGJhY2spIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuICB2YXIgYnVsayA9IHRoaXMuX2J1bGs7XG4gIHZhciBqb2JJZCA9IHRoaXMuam9iLmlkO1xuICB2YXIgam9iID0gdGhpcy5qb2I7XG4gIHZhciBiYXRjaElkID0gdGhpcy5pZDtcblxuICBpZiAoIWpvYklkIHx8ICFiYXRjaElkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQmF0Y2ggbm90IHN0YXJ0ZWQuXCIpO1xuICB9XG5cbiAgcmV0dXJuIGpvYi5pbmZvKCkudGhlbihmdW5jdGlvbihqb2JJbmZvKSB7XG4gICAgcmV0dXJuIGJ1bGsuX3JlcXVlc3Qoe1xuICAgICAgbWV0aG9kIDogJ0dFVCcsXG4gICAgICBwYXRoIDogXCIvam9iL1wiICsgam9iSWQgKyBcIi9iYXRjaC9cIiArIGJhdGNoSWQgKyBcIi9yZXN1bHRcIlxuICAgIH0pO1xuICB9KS50aGVuKGZ1bmN0aW9uKHJlcykge1xuICAgIHZhciByZXN1bHRzO1xuICAgIGlmIChqb2Iub3BlcmF0aW9uID09PSAncXVlcnknKSB7XG4gICAgICB2YXIgY29ubiA9IGJ1bGsuX2Nvbm47XG4gICAgICB2YXIgcmVzdWx0SWRzID0gcmVzWydyZXN1bHQtbGlzdCddLnJlc3VsdDtcbiAgICAgIHJlc3VsdHMgPSByZXNbJ3Jlc3VsdC1saXN0J10ucmVzdWx0O1xuICAgICAgcmVzdWx0cyA9IF8ubWFwKF8uaXNBcnJheShyZXN1bHRzKSA/IHJlc3VsdHMgOiBbIHJlc3VsdHMgXSwgZnVuY3Rpb24oaWQpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBpZDogaWQsXG4gICAgICAgICAgYmF0Y2hJZDogYmF0Y2hJZCxcbiAgICAgICAgICBqb2JJZDogam9iSWRcbiAgICAgICAgfTtcbiAgICAgIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICByZXN1bHRzID0gXy5tYXAocmVzLCBmdW5jdGlvbihyZXQpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBpZDogcmV0LklkIHx8IG51bGwsXG4gICAgICAgICAgc3VjY2VzczogcmV0LlN1Y2Nlc3MgPT09IFwidHJ1ZVwiLFxuICAgICAgICAgIGVycm9yczogcmV0LkVycm9yID8gWyByZXQuRXJyb3IgXSA6IFtdXG4gICAgICAgIH07XG4gICAgICB9KTtcbiAgICB9XG4gICAgc2VsZi5lbWl0KCdyZXNwb25zZScsIHJlc3VsdHMpO1xuICAgIHJldHVybiByZXN1bHRzO1xuICB9KS5mYWlsKGZ1bmN0aW9uKGVycikge1xuICAgIHNlbGYuZW1pdCgnZXJyb3InLCBlcnIpO1xuICAgIHRocm93IGVycjtcbiAgfSkudGhlbkNhbGwoY2FsbGJhY2spO1xufTtcblxuLyoqXG4gKiBGZXRjaCBxdWVyeSByZXN1bHQgYXMgYSByZWNvcmQgc3RyZWFtXG4gKiBAcGFyYW0ge1N0cmluZ30gcmVzdWx0SWQgLSBSZXN1bHQgaWRcbiAqIEByZXR1cm5zIHtSZWNvcmRTdHJlYW19IC0gUmVjb3JkIHN0cmVhbSwgY29udmVydGlibGUgdG8gQ1NWIGRhdGEgc3RyZWFtXG4gKi9cbkJhdGNoLnByb3RvdHlwZS5yZXN1bHQgPSBmdW5jdGlvbihyZXN1bHRJZCkge1xuICB2YXIgam9iSWQgPSB0aGlzLmpvYi5pZDtcbiAgdmFyIGJhdGNoSWQgPSB0aGlzLmlkO1xuICBpZiAoIWpvYklkIHx8ICFiYXRjaElkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQmF0Y2ggbm90IHN0YXJ0ZWQuXCIpO1xuICB9XG4gIHZhciByZXN1bHRTdHJlYW0gPSBuZXcgUmVjb3JkU3RyZWFtLlBhcnNhYmxlKCk7XG4gIHZhciByZXN1bHREYXRhU3RyZWFtID0gcmVzdWx0U3RyZWFtLnN0cmVhbSgnY3N2Jyk7XG5cbiAgdmFyIHJlcVN0cmVhbSA9IHRoaXMuX2J1bGsuX3JlcXVlc3Qoe1xuICAgIG1ldGhvZCA6ICdHRVQnLFxuICAgIHBhdGggOiBcIi9qb2IvXCIgKyBqb2JJZCArIFwiL2JhdGNoL1wiICsgYmF0Y2hJZCArIFwiL3Jlc3VsdC9cIiArIHJlc3VsdElkLFxuICAgIHJlc3BvbnNlVHlwZTogXCJhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1cIixcbiAgICBmb3JldmVyOiB0cnVlLFxuICAgIGd6aXA6IHRydWVcbiAgfSkuc3RyZWFtKClcbiAgICAub24oJ2Vycm9yJywgZXJyID0+IHJlc3VsdERhdGFTdHJlYW0uZW1pdCgnZXJyb3InLCBlcnIpKVxuICAgIC5waXBlKHJlc3VsdERhdGFTdHJlYW0pO1xuXG4gIHJldHVybiByZXN1bHRTdHJlYW07XG59O1xuXG4vKi0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tKi9cbi8qKlxuICogQHByaXZhdGVcbiAqL1xudmFyIEJ1bGtBcGkgPSBmdW5jdGlvbigpIHtcbiAgQnVsa0FwaS5zdXBlcl8uYXBwbHkodGhpcywgYXJndW1lbnRzKTtcbn07XG5cbmluaGVyaXRzKEJ1bGtBcGksIEh0dHBBcGkpO1xuXG5CdWxrQXBpLnByb3RvdHlwZS5iZWZvcmVTZW5kID0gZnVuY3Rpb24ocmVxdWVzdCkge1xuICByZXF1ZXN0LmhlYWRlcnMgPSByZXF1ZXN0LmhlYWRlcnMgfHwge307XG4gIHJlcXVlc3QuaGVhZGVyc1tcIlgtU0ZEQy1TRVNTSU9OXCJdID0gdGhpcy5fY29ubi5hY2Nlc3NUb2tlbjtcbn07XG5cbkJ1bGtBcGkucHJvdG90eXBlLmlzU2Vzc2lvbkV4cGlyZWQgPSBmdW5jdGlvbihyZXNwb25zZSkge1xuICByZXR1cm4gcmVzcG9uc2Uuc3RhdHVzQ29kZSA9PT0gNDAwICYmXG4gICAgLzxleGNlcHRpb25Db2RlPkludmFsaWRTZXNzaW9uSWQ8XFwvZXhjZXB0aW9uQ29kZT4vLnRlc3QocmVzcG9uc2UuYm9keSk7XG59O1xuXG5CdWxrQXBpLnByb3RvdHlwZS5oYXNFcnJvckluUmVzcG9uc2VCb2R5ID0gZnVuY3Rpb24oYm9keSkge1xuICByZXR1cm4gISFib2R5LmVycm9yO1xufTtcblxuQnVsa0FwaS5wcm90b3R5cGUucGFyc2VFcnJvciA9IGZ1bmN0aW9uKGJvZHkpIHtcbiAgcmV0dXJuIHtcbiAgICBlcnJvckNvZGU6IGJvZHkuZXJyb3IuZXhjZXB0aW9uQ29kZSxcbiAgICBtZXNzYWdlOiBib2R5LmVycm9yLmV4Y2VwdGlvbk1lc3NhZ2VcbiAgfTtcbn07XG5cbi8qLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0qL1xuXG4vKipcbiAqIENsYXNzIGZvciBCdWxrIEFQSVxuICpcbiAqIEBjbGFzc1xuICogQHBhcmFtIHtDb25uZWN0aW9ufSBjb25uIC0gQ29ubmVjdGlvbiBvYmplY3RcbiAqL1xudmFyIEJ1bGsgPSBmdW5jdGlvbihjb25uKSB7XG4gIHRoaXMuX2Nvbm4gPSBjb25uO1xuICB0aGlzLl9sb2dnZXIgPSBjb25uLl9sb2dnZXI7XG59O1xuXG4vKipcbiAqIFBvbGxpbmcgaW50ZXJ2YWwgaW4gbWlsbGlzZWNvbmRzXG4gKiBAdHlwZSB7TnVtYmVyfVxuICovXG5CdWxrLnByb3RvdHlwZS5wb2xsSW50ZXJ2YWwgPSAxMDAwO1xuXG4vKipcbiAqIFBvbGxpbmcgdGltZW91dCBpbiBtaWxsaXNlY29uZHNcbiAqIEB0eXBlIHtOdW1iZXJ9XG4gKi9cbkJ1bGsucHJvdG90eXBlLnBvbGxUaW1lb3V0ID0gMTAwMDA7XG5cbi8qKiBAcHJpdmF0ZSAqKi9cbkJ1bGsucHJvdG90eXBlLl9yZXF1ZXN0ID0gZnVuY3Rpb24ocmVxdWVzdCwgY2FsbGJhY2spIHtcbiAgdmFyIGNvbm4gPSB0aGlzLl9jb25uO1xuICByZXF1ZXN0ID0gXy5jbG9uZShyZXF1ZXN0KTtcbiAgdmFyIGJhc2VVcmwgPSBbIGNvbm4uaW5zdGFuY2VVcmwsIFwic2VydmljZXMvYXN5bmNcIiwgY29ubi52ZXJzaW9uIF0uam9pbignLycpO1xuICByZXF1ZXN0LnVybCA9IGJhc2VVcmwgKyByZXF1ZXN0LnBhdGg7XG4gIHZhciBvcHRpb25zID0geyByZXNwb25zZVR5cGU6IHJlcXVlc3QucmVzcG9uc2VUeXBlIH07XG4gIGRlbGV0ZSByZXF1ZXN0LnBhdGg7XG4gIGRlbGV0ZSByZXF1ZXN0LnJlc3BvbnNlVHlwZTtcbiAgcmV0dXJuIG5ldyBCdWxrQXBpKHRoaXMuX2Nvbm4sIG9wdGlvbnMpXG4gICAgLm9uKCdyZXF1ZXN0RHVyYXRpb24nLCAoZHVyYXRpb24pID0+IGNvbm4uZW1pdCgncmVxdWVzdER1cmF0aW9uJywgZHVyYXRpb24pKVxuICAgIC5yZXF1ZXN0KHJlcXVlc3QpXG4gICAgLnRoZW5DYWxsKGNhbGxiYWNrKTtcbn07XG5cbi8qKlxuICogQ3JlYXRlIGFuZCBzdGFydCBidWxrbG9hZCBqb2IgYW5kIGJhdGNoXG4gKlxuICogQHBhcmFtIHtTdHJpbmd9IHR5cGUgLSBTT2JqZWN0IHR5cGVcbiAqIEBwYXJhbSB7U3RyaW5nfSBvcGVyYXRpb24gLSBCdWxrIGxvYWQgb3BlcmF0aW9uICgnaW5zZXJ0JywgJ3VwZGF0ZScsICd1cHNlcnQnLCAnZGVsZXRlJywgb3IgJ2hhcmREZWxldGUnKVxuICogQHBhcmFtIHtPYmplY3R9IFtvcHRpb25zXSAtIE9wdGlvbnMgZm9yIGJ1bGsgbG9hZGluZyBvcGVyYXRpb25cbiAqIEBwYXJhbSB7U3RyaW5nfSBbb3B0aW9ucy5leHRJZEZpZWxkXSAtIEV4dGVybmFsIElEIGZpZWxkIG5hbWUgKHVzZWQgd2hlbiB1cHNlcnQgb3BlcmF0aW9uKS5cbiAqIEBwYXJhbSB7U3RyaW5nfSBbb3B0aW9ucy5jb25jdXJyZW5jeU1vZGVdIC0gJ1NlcmlhbCcgb3IgJ1BhcmFsbGVsJy4gRGVmYXVsdHMgdG8gUGFyYWxsZWwuXG4gKiBAcGFyYW0ge0FycmF5LjxSZWNvcmQ+fHN0cmVhbS5TdHJlYW18U3RyaW5nfSBbaW5wdXRdIC0gSW5wdXQgc291cmNlIGZvciBidWxrbG9hZC4gQWNjZXB0cyBhcnJheSBvZiByZWNvcmRzLCBDU1Ygc3RyaW5nLCBhbmQgQ1NWIGRhdGEgaW5wdXQgc3RyZWFtIGluIGluc2VydC91cGRhdGUvdXBzZXJ0L2RlbGV0ZS9oYXJkRGVsZXRlIG9wZXJhdGlvbiwgU09RTCBzdHJpbmcgaW4gcXVlcnkgb3BlcmF0aW9uLlxuICogQHBhcmFtIHtDYWxsYmFjay48QXJyYXkuPFJlY29yZFJlc3VsdD58QXJyYXkuPEJ1bGt+QmF0Y2hSZXN1bHRJbmZvPj59IFtjYWxsYmFja10gLSBDYWxsYmFjayBmdW5jdGlvblxuICogQHJldHVybnMge0J1bGt+QmF0Y2h9XG4gKi9cbkJ1bGsucHJvdG90eXBlLmxvYWQgPSBmdW5jdGlvbih0eXBlLCBvcGVyYXRpb24sIG9wdGlvbnMsIGlucHV0LCBjYWxsYmFjaykge1xuICB2YXIgc2VsZiA9IHRoaXM7XG4gIGlmICghdHlwZSB8fCAhb3BlcmF0aW9uKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiSW5zdWZmaWNpZW50IGFyZ3VtZW50cy4gQXQgbGVhc3QsICd0eXBlJyBhbmQgJ29wZXJhdGlvbicgYXJlIHJlcXVpcmVkLlwiKTtcbiAgfVxuICBpZiAoIV8uaXNPYmplY3Qob3B0aW9ucykgfHwgb3B0aW9ucy5jb25zdHJ1Y3RvciAhPT0gT2JqZWN0KSB7IC8vIHdoZW4gb3B0aW9ucyBpcyBub3QgcGxhaW4gaGFzaCBvYmplY3QsIGl0IGlzIG9taXR0ZWRcbiAgICBjYWxsYmFjayA9IGlucHV0O1xuICAgIGlucHV0ID0gb3B0aW9ucztcbiAgICBvcHRpb25zID0gbnVsbDtcbiAgfVxuICB2YXIgam9iID0gdGhpcy5jcmVhdGVKb2IodHlwZSwgb3BlcmF0aW9uLCBvcHRpb25zKTtcbiAgam9iLm9uY2UoJ2Vycm9yJywgZnVuY3Rpb24gKGVycm9yKSB7XG4gICAgaWYgKGJhdGNoKSB7XG4gICAgICBiYXRjaC5lbWl0KCdlcnJvcicsIGVycm9yKTsgLy8gcGFzcyBqb2IgZXJyb3IgdG8gYmF0Y2hcbiAgICB9XG4gIH0pO1xuICB2YXIgYmF0Y2ggPSBqb2IuY3JlYXRlQmF0Y2goKTtcbiAgdmFyIGNsZWFudXAgPSBmdW5jdGlvbigpIHtcbiAgICBiYXRjaCA9IG51bGw7XG4gICAgam9iLmNsb3NlKCk7XG4gIH07XG4gIHZhciBjbGVhbnVwT25FcnJvciA9IGZ1bmN0aW9uKGVycikge1xuICAgIGlmIChlcnIubmFtZSAhPT0gJ1BvbGxpbmdUaW1lb3V0Jykge1xuICAgICAgY2xlYW51cCgpO1xuICAgIH1cbiAgfTtcbiAgYmF0Y2gub24oJ3Jlc3BvbnNlJywgY2xlYW51cCk7XG4gIGJhdGNoLm9uKCdlcnJvcicsIGNsZWFudXBPbkVycm9yKTtcbiAgYmF0Y2gub24oJ3F1ZXVlJywgZnVuY3Rpb24oKSB7IGJhdGNoLnBvbGwoc2VsZi5wb2xsSW50ZXJ2YWwsIHNlbGYucG9sbFRpbWVvdXQpOyB9KTtcbiAgcmV0dXJuIGJhdGNoLmV4ZWN1dGUoaW5wdXQsIGNhbGxiYWNrKTtcbn07XG5cbi8qKlxuICogRXhlY3V0ZSBidWxrIHF1ZXJ5IGFuZCBnZXQgcmVjb3JkIHN0cmVhbVxuICpcbiAqIEBwYXJhbSB7U3RyaW5nfSBzb3FsIC0gU09RTCB0byBleGVjdXRlIGluIGJ1bGsgam9iXG4gKiBAcGFyYW0ge09iamVjdH0gb3B0aW9ucyAtIE9wdGlvbnMgb24gaG93IHRvIGV4ZWN1dGUgdGhlIEpvYlxuICogQHJldHVybnMge1JlY29yZFN0cmVhbS5QYXJzYWJsZX0gLSBSZWNvcmQgc3RyZWFtLCBjb252ZXJ0aWJsZSB0byBDU1YgZGF0YSBzdHJlYW1cbiAqL1xuQnVsay5wcm90b3R5cGUucXVlcnkgPSBmdW5jdGlvbihzb3FsLCBvcHRpb25zKSB7XG4gIHZhciBtID0gc29xbC5yZXBsYWNlKC9cXChbXFxzXFxTXStcXCkvZywgJycpLm1hdGNoKC9GUk9NXFxzKyhcXHcrKS9pKTtcbiAgaWYgKCFtKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiTm8gc29iamVjdCB0eXBlIGZvdW5kIGluIHF1ZXJ5LCBtYXliZSBjYXVzZWQgYnkgaW52YWxpZCBTT1FMLlwiKTtcbiAgfVxuICB2YXIgdHlwZSA9IG1bMV07XG4gIHZhciBzZWxmID0gdGhpcztcbiAgdmFyIHJlY29yZFN0cmVhbSA9IG5ldyBSZWNvcmRTdHJlYW0uUGFyc2FibGUoKTtcbiAgdmFyIGRhdGFTdHJlYW0gPSByZWNvcmRTdHJlYW0uc3RyZWFtKCdjc3YnKTtcblxuICB0aGlzLmxvYWQodHlwZSwgXCJxdWVyeVwiLCBvcHRpb25zIHx8IHt9LCBzb3FsKS50aGVuKGZ1bmN0aW9uKHJlc3VsdHMpIHtcbiAgICB2YXIgbGF6eUxvYWRlZFJlc3VsdFN0cmVhbXMgPSByZXN1bHRzLm1hcChmdW5jdGlvbihyZXN1bHQpIHtcbiAgICAgIGNvbnN0IGJhdGNoID0gc2VsZlxuICAgICAgICAuam9iKHJlc3VsdC5qb2JJZClcbiAgICAgICAgLmJhdGNoKHJlc3VsdC5iYXRjaElkKTtcblxuICAgICAgcmV0dXJuIGZ1bmN0aW9uKCkge1xuICAgICAgICByZXR1cm4gYmF0Y2hcbiAgICAgICAgICAucmVzdWx0KHJlc3VsdC5pZClcbiAgICAgICAgICAuc3RyZWFtKCk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBqb2luU3RyZWFtcyhsYXp5TG9hZGVkUmVzdWx0U3RyZWFtcylcbiAgICAgIC5vbignZXJyb3InLCBlcnIgPT4gZGF0YVN0cmVhbS5lbWl0KCdlcnJvcicsIGVycikpXG4gICAgICAub24oJ2VuZCcsICgpID0+IGRhdGFTdHJlYW0uZW1pdCgnZW5kJykpXG4gICAgICAucGlwZShkYXRhU3RyZWFtKTtcbiAgfSkuZmFpbChmdW5jdGlvbihlcnIpIHtcbiAgICBkYXRhU3RyZWFtLmVtaXQoJ2Vycm9yJywgZXJyKTtcbiAgfSk7XG4gIHJldHVybiByZWNvcmRTdHJlYW07XG59O1xuXG5cbi8qKlxuICogQ3JlYXRlIGEgbmV3IGpvYiBpbnN0YW5jZVxuICpcbiAqIEBwYXJhbSB7U3RyaW5nfSB0eXBlIC0gU09iamVjdCB0eXBlXG4gKiBAcGFyYW0ge1N0cmluZ30gb3BlcmF0aW9uIC0gQnVsayBsb2FkIG9wZXJhdGlvbiAoJ2luc2VydCcsICd1cGRhdGUnLCAndXBzZXJ0JywgJ2RlbGV0ZScsICdoYXJkRGVsZXRlJywgb3IgJ3F1ZXJ5JylcbiAqIEBwYXJhbSB7T2JqZWN0fSBbb3B0aW9uc10gLSBPcHRpb25zIGZvciBidWxrIGxvYWRpbmcgb3BlcmF0aW9uXG4gKiBAcmV0dXJucyB7QnVsa35Kb2J9XG4gKi9cbkJ1bGsucHJvdG90eXBlLmNyZWF0ZUpvYiA9IGZ1bmN0aW9uKHR5cGUsIG9wZXJhdGlvbiwgb3B0aW9ucykge1xuICByZXR1cm4gbmV3IEpvYih0aGlzLCB0eXBlLCBvcGVyYXRpb24sIG9wdGlvbnMpO1xufTtcblxuLyoqXG4gKiBHZXQgYSBqb2IgaW5zdGFuY2Ugc3BlY2lmaWVkIGJ5IGdpdmVuIGpvYiBJRFxuICpcbiAqIEBwYXJhbSB7U3RyaW5nfSBqb2JJZCAtIEpvYiBJRFxuICogQHJldHVybnMge0J1bGt+Sm9ifVxuICovXG5CdWxrLnByb3RvdHlwZS5qb2IgPSBmdW5jdGlvbihqb2JJZCkge1xuICByZXR1cm4gbmV3IEpvYih0aGlzLCBudWxsLCBudWxsLCBudWxsLCBqb2JJZCk7XG59O1xuXG5cbi8qLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0qL1xuLypcbiAqIFJlZ2lzdGVyIGhvb2sgaW4gY29ubmVjdGlvbiBpbnN0YW50aWF0aW9uIGZvciBkeW5hbWljYWxseSBhZGRpbmcgdGhpcyBBUEkgbW9kdWxlIGZlYXR1cmVzXG4gKi9cbmpzZm9yY2Uub24oJ2Nvbm5lY3Rpb246bmV3JywgZnVuY3Rpb24oY29ubikge1xuICBjb25uLmJ1bGsgPSBuZXcgQnVsayhjb25uKTtcbn0pO1xuXG5cbm1vZHVsZS5leHBvcnRzID0gQnVsaztcbiIsIi8vIHNoaW0gZm9yIHVzaW5nIHByb2Nlc3MgaW4gYnJvd3NlclxudmFyIHByb2Nlc3MgPSBtb2R1bGUuZXhwb3J0cyA9IHt9O1xuXG4vLyBjYWNoZWQgZnJvbSB3aGF0ZXZlciBnbG9iYWwgaXMgcHJlc2VudCBzbyB0aGF0IHRlc3QgcnVubmVycyB0aGF0IHN0dWIgaXRcbi8vIGRvbid0IGJyZWFrIHRoaW5ncy4gIEJ1dCB3ZSBuZWVkIHRvIHdyYXAgaXQgaW4gYSB0cnkgY2F0Y2ggaW4gY2FzZSBpdCBpc1xuLy8gd3JhcHBlZCBpbiBzdHJpY3QgbW9kZSBjb2RlIHdoaWNoIGRvZXNuJ3QgZGVmaW5lIGFueSBnbG9iYWxzLiAgSXQncyBpbnNpZGUgYVxuLy8gZnVuY3Rpb24gYmVjYXVzZSB0cnkvY2F0Y2hlcyBkZW9wdGltaXplIGluIGNlcnRhaW4gZW5naW5lcy5cblxudmFyIGNhY2hlZFNldFRpbWVvdXQ7XG52YXIgY2FjaGVkQ2xlYXJUaW1lb3V0O1xuXG5mdW5jdGlvbiBkZWZhdWx0U2V0VGltb3V0KCkge1xuICAgIHRocm93IG5ldyBFcnJvcignc2V0VGltZW91dCBoYXMgbm90IGJlZW4gZGVmaW5lZCcpO1xufVxuZnVuY3Rpb24gZGVmYXVsdENsZWFyVGltZW91dCAoKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdjbGVhclRpbWVvdXQgaGFzIG5vdCBiZWVuIGRlZmluZWQnKTtcbn1cbihmdW5jdGlvbiAoKSB7XG4gICAgdHJ5IHtcbiAgICAgICAgaWYgKHR5cGVvZiBzZXRUaW1lb3V0ID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICBjYWNoZWRTZXRUaW1lb3V0ID0gc2V0VGltZW91dDtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNhY2hlZFNldFRpbWVvdXQgPSBkZWZhdWx0U2V0VGltb3V0O1xuICAgICAgICB9XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBjYWNoZWRTZXRUaW1lb3V0ID0gZGVmYXVsdFNldFRpbW91dDtcbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgICAgaWYgKHR5cGVvZiBjbGVhclRpbWVvdXQgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgIGNhY2hlZENsZWFyVGltZW91dCA9IGNsZWFyVGltZW91dDtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNhY2hlZENsZWFyVGltZW91dCA9IGRlZmF1bHRDbGVhclRpbWVvdXQ7XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGNhY2hlZENsZWFyVGltZW91dCA9IGRlZmF1bHRDbGVhclRpbWVvdXQ7XG4gICAgfVxufSAoKSlcbmZ1bmN0aW9uIHJ1blRpbWVvdXQoZnVuKSB7XG4gICAgaWYgKGNhY2hlZFNldFRpbWVvdXQgPT09IHNldFRpbWVvdXQpIHtcbiAgICAgICAgLy9ub3JtYWwgZW52aXJvbWVudHMgaW4gc2FuZSBzaXR1YXRpb25zXG4gICAgICAgIHJldHVybiBzZXRUaW1lb3V0KGZ1biwgMCk7XG4gICAgfVxuICAgIC8vIGlmIHNldFRpbWVvdXQgd2Fzbid0IGF2YWlsYWJsZSBidXQgd2FzIGxhdHRlciBkZWZpbmVkXG4gICAgaWYgKChjYWNoZWRTZXRUaW1lb3V0ID09PSBkZWZhdWx0U2V0VGltb3V0IHx8ICFjYWNoZWRTZXRUaW1lb3V0KSAmJiBzZXRUaW1lb3V0KSB7XG4gICAgICAgIGNhY2hlZFNldFRpbWVvdXQgPSBzZXRUaW1lb3V0O1xuICAgICAgICByZXR1cm4gc2V0VGltZW91dChmdW4sIDApO1xuICAgIH1cbiAgICB0cnkge1xuICAgICAgICAvLyB3aGVuIHdoZW4gc29tZWJvZHkgaGFzIHNjcmV3ZWQgd2l0aCBzZXRUaW1lb3V0IGJ1dCBubyBJLkUuIG1hZGRuZXNzXG4gICAgICAgIHJldHVybiBjYWNoZWRTZXRUaW1lb3V0KGZ1biwgMCk7XG4gICAgfSBjYXRjaChlKXtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIC8vIFdoZW4gd2UgYXJlIGluIEkuRS4gYnV0IHRoZSBzY3JpcHQgaGFzIGJlZW4gZXZhbGVkIHNvIEkuRS4gZG9lc24ndCB0cnVzdCB0aGUgZ2xvYmFsIG9iamVjdCB3aGVuIGNhbGxlZCBub3JtYWxseVxuICAgICAgICAgICAgcmV0dXJuIGNhY2hlZFNldFRpbWVvdXQuY2FsbChudWxsLCBmdW4sIDApO1xuICAgICAgICB9IGNhdGNoKGUpe1xuICAgICAgICAgICAgLy8gc2FtZSBhcyBhYm92ZSBidXQgd2hlbiBpdCdzIGEgdmVyc2lvbiBvZiBJLkUuIHRoYXQgbXVzdCBoYXZlIHRoZSBnbG9iYWwgb2JqZWN0IGZvciAndGhpcycsIGhvcGZ1bGx5IG91ciBjb250ZXh0IGNvcnJlY3Qgb3RoZXJ3aXNlIGl0IHdpbGwgdGhyb3cgYSBnbG9iYWwgZXJyb3JcbiAgICAgICAgICAgIHJldHVybiBjYWNoZWRTZXRUaW1lb3V0LmNhbGwodGhpcywgZnVuLCAwKTtcbiAgICAgICAgfVxuICAgIH1cblxuXG59XG5mdW5jdGlvbiBydW5DbGVhclRpbWVvdXQobWFya2VyKSB7XG4gICAgaWYgKGNhY2hlZENsZWFyVGltZW91dCA9PT0gY2xlYXJUaW1lb3V0KSB7XG4gICAgICAgIC8vbm9ybWFsIGVudmlyb21lbnRzIGluIHNhbmUgc2l0dWF0aW9uc1xuICAgICAgICByZXR1cm4gY2xlYXJUaW1lb3V0KG1hcmtlcik7XG4gICAgfVxuICAgIC8vIGlmIGNsZWFyVGltZW91dCB3YXNuJ3QgYXZhaWxhYmxlIGJ1dCB3YXMgbGF0dGVyIGRlZmluZWRcbiAgICBpZiAoKGNhY2hlZENsZWFyVGltZW91dCA9PT0gZGVmYXVsdENsZWFyVGltZW91dCB8fCAhY2FjaGVkQ2xlYXJUaW1lb3V0KSAmJiBjbGVhclRpbWVvdXQpIHtcbiAgICAgICAgY2FjaGVkQ2xlYXJUaW1lb3V0ID0gY2xlYXJUaW1lb3V0O1xuICAgICAgICByZXR1cm4gY2xlYXJUaW1lb3V0KG1hcmtlcik7XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICAgIC8vIHdoZW4gd2hlbiBzb21lYm9keSBoYXMgc2NyZXdlZCB3aXRoIHNldFRpbWVvdXQgYnV0IG5vIEkuRS4gbWFkZG5lc3NcbiAgICAgICAgcmV0dXJuIGNhY2hlZENsZWFyVGltZW91dChtYXJrZXIpO1xuICAgIH0gY2F0Y2ggKGUpe1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgLy8gV2hlbiB3ZSBhcmUgaW4gSS5FLiBidXQgdGhlIHNjcmlwdCBoYXMgYmVlbiBldmFsZWQgc28gSS5FLiBkb2Vzbid0ICB0cnVzdCB0aGUgZ2xvYmFsIG9iamVjdCB3aGVuIGNhbGxlZCBub3JtYWxseVxuICAgICAgICAgICAgcmV0dXJuIGNhY2hlZENsZWFyVGltZW91dC5jYWxsKG51bGwsIG1hcmtlcik7XG4gICAgICAgIH0gY2F0Y2ggKGUpe1xuICAgICAgICAgICAgLy8gc2FtZSBhcyBhYm92ZSBidXQgd2hlbiBpdCdzIGEgdmVyc2lvbiBvZiBJLkUuIHRoYXQgbXVzdCBoYXZlIHRoZSBnbG9iYWwgb2JqZWN0IGZvciAndGhpcycsIGhvcGZ1bGx5IG91ciBjb250ZXh0IGNvcnJlY3Qgb3RoZXJ3aXNlIGl0IHdpbGwgdGhyb3cgYSBnbG9iYWwgZXJyb3IuXG4gICAgICAgICAgICAvLyBTb21lIHZlcnNpb25zIG9mIEkuRS4gaGF2ZSBkaWZmZXJlbnQgcnVsZXMgZm9yIGNsZWFyVGltZW91dCB2cyBzZXRUaW1lb3V0XG4gICAgICAgICAgICByZXR1cm4gY2FjaGVkQ2xlYXJUaW1lb3V0LmNhbGwodGhpcywgbWFya2VyKTtcbiAgICAgICAgfVxuICAgIH1cblxuXG5cbn1cbnZhciBxdWV1ZSA9IFtdO1xudmFyIGRyYWluaW5nID0gZmFsc2U7XG52YXIgY3VycmVudFF1ZXVlO1xudmFyIHF1ZXVlSW5kZXggPSAtMTtcblxuZnVuY3Rpb24gY2xlYW5VcE5leHRUaWNrKCkge1xuICAgIGlmICghZHJhaW5pbmcgfHwgIWN1cnJlbnRRdWV1ZSkge1xuICAgICAgICByZXR1cm47XG4gICAgfVxuICAgIGRyYWluaW5nID0gZmFsc2U7XG4gICAgaWYgKGN1cnJlbnRRdWV1ZS5sZW5ndGgpIHtcbiAgICAgICAgcXVldWUgPSBjdXJyZW50UXVldWUuY29uY2F0KHF1ZXVlKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICBxdWV1ZUluZGV4ID0gLTE7XG4gICAgfVxuICAgIGlmIChxdWV1ZS5sZW5ndGgpIHtcbiAgICAgICAgZHJhaW5RdWV1ZSgpO1xuICAgIH1cbn1cblxuZnVuY3Rpb24gZHJhaW5RdWV1ZSgpIHtcbiAgICBpZiAoZHJhaW5pbmcpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB2YXIgdGltZW91dCA9IHJ1blRpbWVvdXQoY2xlYW5VcE5leHRUaWNrKTtcbiAgICBkcmFpbmluZyA9IHRydWU7XG5cbiAgICB2YXIgbGVuID0gcXVldWUubGVuZ3RoO1xuICAgIHdoaWxlKGxlbikge1xuICAgICAgICBjdXJyZW50UXVldWUgPSBxdWV1ZTtcbiAgICAgICAgcXVldWUgPSBbXTtcbiAgICAgICAgd2hpbGUgKCsrcXVldWVJbmRleCA8IGxlbikge1xuICAgICAgICAgICAgaWYgKGN1cnJlbnRRdWV1ZSkge1xuICAgICAgICAgICAgICAgIGN1cnJlbnRRdWV1ZVtxdWV1ZUluZGV4XS5ydW4oKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBxdWV1ZUluZGV4ID0gLTE7XG4gICAgICAgIGxlbiA9IHF1ZXVlLmxlbmd0aDtcbiAgICB9XG4gICAgY3VycmVudFF1ZXVlID0gbnVsbDtcbiAgICBkcmFpbmluZyA9IGZhbHNlO1xuICAgIHJ1bkNsZWFyVGltZW91dCh0aW1lb3V0KTtcbn1cblxucHJvY2Vzcy5uZXh0VGljayA9IGZ1bmN0aW9uIChmdW4pIHtcbiAgICB2YXIgYXJncyA9IG5ldyBBcnJheShhcmd1bWVudHMubGVuZ3RoIC0gMSk7XG4gICAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPiAxKSB7XG4gICAgICAgIGZvciAodmFyIGkgPSAxOyBpIDwgYXJndW1lbnRzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgICBhcmdzW2kgLSAxXSA9IGFyZ3VtZW50c1tpXTtcbiAgICAgICAgfVxuICAgIH1cbiAgICBxdWV1ZS5wdXNoKG5ldyBJdGVtKGZ1biwgYXJncykpO1xuICAgIGlmIChxdWV1ZS5sZW5ndGggPT09IDEgJiYgIWRyYWluaW5nKSB7XG4gICAgICAgIHJ1blRpbWVvdXQoZHJhaW5RdWV1ZSk7XG4gICAgfVxufTtcblxuLy8gdjggbGlrZXMgcHJlZGljdGlibGUgb2JqZWN0c1xuZnVuY3Rpb24gSXRlbShmdW4sIGFycmF5KSB7XG4gICAgdGhpcy5mdW4gPSBmdW47XG4gICAgdGhpcy5hcnJheSA9IGFycmF5O1xufVxuSXRlbS5wcm90b3R5cGUucnVuID0gZnVuY3Rpb24gKCkge1xuICAgIHRoaXMuZnVuLmFwcGx5KG51bGwsIHRoaXMuYXJyYXkpO1xufTtcbnByb2Nlc3MudGl0bGUgPSAnYnJvd3Nlcic7XG5wcm9jZXNzLmJyb3dzZXIgPSB0cnVlO1xucHJvY2Vzcy5lbnYgPSB7fTtcbnByb2Nlc3MuYXJndiA9IFtdO1xucHJvY2Vzcy52ZXJzaW9uID0gJyc7IC8vIGVtcHR5IHN0cmluZyB0byBhdm9pZCByZWdleHAgaXNzdWVzXG5wcm9jZXNzLnZlcnNpb25zID0ge307XG5cbmZ1bmN0aW9uIG5vb3AoKSB7fVxuXG5wcm9jZXNzLm9uID0gbm9vcDtcbnByb2Nlc3MuYWRkTGlzdGVuZXIgPSBub29wO1xucHJvY2Vzcy5vbmNlID0gbm9vcDtcbnByb2Nlc3Mub2ZmID0gbm9vcDtcbnByb2Nlc3MucmVtb3ZlTGlzdGVuZXIgPSBub29wO1xucHJvY2Vzcy5yZW1vdmVBbGxMaXN0ZW5lcnMgPSBub29wO1xucHJvY2Vzcy5lbWl0ID0gbm9vcDtcbnByb2Nlc3MucHJlcGVuZExpc3RlbmVyID0gbm9vcDtcbnByb2Nlc3MucHJlcGVuZE9uY2VMaXN0ZW5lciA9IG5vb3A7XG5cbnByb2Nlc3MubGlzdGVuZXJzID0gZnVuY3Rpb24gKG5hbWUpIHsgcmV0dXJuIFtdIH1cblxucHJvY2Vzcy5iaW5kaW5nID0gZnVuY3Rpb24gKG5hbWUpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ3Byb2Nlc3MuYmluZGluZyBpcyBub3Qgc3VwcG9ydGVkJyk7XG59O1xuXG5wcm9jZXNzLmN3ZCA9IGZ1bmN0aW9uICgpIHsgcmV0dXJuICcvJyB9O1xucHJvY2Vzcy5jaGRpciA9IGZ1bmN0aW9uIChkaXIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ3Byb2Nlc3MuY2hkaXIgaXMgbm90IHN1cHBvcnRlZCcpO1xufTtcbnByb2Nlc3MudW1hc2sgPSBmdW5jdGlvbigpIHsgcmV0dXJuIDA7IH07XG4iXX0=
