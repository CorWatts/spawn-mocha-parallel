"use strict";

// Module Requirements
var _ = require('lodash'),
  proc = require('child_process'),
  join = require('path').join,
  async = require('async'),
  util = require('util'),
  EventEmitter = require('events').EventEmitter,
  streamBuffers = require("stream-buffers"),
  through = require('through'),
  split = require('split'),
  Promise = require('bluebird'),
  fs = Promise.promisifyAll(require('fs'));

require('colors');

var SpawnMocha = function (opts) {
  var _this = this;
  opts = opts || {};
  _.defaults(opts, {
    errorSummary: true
  });

  let filelist = []; // array of temporary output filenames
  let errors = []

  var queue = async.queue(function (task, done) {
    // Setup
    var overrideOpts = _.merge(_.clone(opts), task.overrideOpts);
    var bin = _.isFunction(opts.bin) ? opts.bin() : opts.bin ||
    join(__dirname, '..', 'node_modules', '.bin', 'mocha');
    var env = _.isFunction(overrideOpts.env) ? overrideOpts.env() : overrideOpts.env || process.env;
    env = _.clone(env);

    // Generate arguments
    var args = [];
    _(overrideOpts.flags).each(function (val, key) {
      if (_.isFunction(val)) val = val();
      if(_.isArray(val)) {
        val.map(function(v) {
          args.push((key.length > 1 ? '--' : '-') + key);
          args.push(v);
        });
      } else {
        args.push((key.length > 1 ? '--' : '-') + key);
        if (_.isString(val) || _.isNumber(val)) {
          args.push(val);
        }
      }
    });

    // Split xunit test report in several files if required
    if (env.JUNIT_REPORT_PATH) {
      env.JUNIT_REPORT_PATH = env.JUNIT_REPORT_PATH.replace(/xml$/, task.taskNum + '.xml');
    }
    // Execute Mocha
    let filepath = '/tmp/mocha.'+task.taskNum
    filelist.push(filepath)

    let file = fs.createWriteStream('/tmp/mocha.'+task.taskNum, {encoding: 'utf8'});
    file.on('open', function() {
      let child = proc.spawn(bin, args.concat(task.files), {env: env, stdio: ['pipe', file, file]});

      // When done...
      child.on('close', function (errCode) {
        if (errCode) {
          const err = new Error('Error for files: ' + task.files.join(', '));
          err.stack = [];
          err.files = task.files;
          err.code = errCode;
          done(err);
        } else {
          done(null);
        }
      });
    })
  }, opts.concurrency || 1);

  // called when last queue item is complete
  queue.drain = function () {
    // concatenate files and write to stdout
    const write = fs.createWriteStream(opts.outputFile || '/tmp/mochaOutput', {encoding: 'utf8'})
    Promise
      .mapSeries(filelist, (file) => new Promise((resolve, reject) => {
        const read = fs.createReadStream(file, {encoding: 'utf8'}).on('end', resolve).on('error', reject)
        read.pipe(write, {end: false})
        read.pipe(process.stdout, {end: false})
      }))
      .then(() => {
        write.end()
        if(errors.length) {
          errors.map(err => _this.emit('error', err))
        }
        _this.emit('end');
      })
    
  };

  var taskNum = 0;
  this.add = function (files, overrideOpts) {
    taskNum++;
    if (!_.isArray(files)) {
      files = [files];
    }
    var task = {taskNum: taskNum, files: files, overrideOpts: overrideOpts || {}};
    queue.push(task, function (err, results) {
      if (err) {
        errors.push(err)
      }
      _this.emit('done', results)
    });
  };
};


util.inherits(SpawnMocha, EventEmitter);

var mochaStream = function mocha(opts) {
  opts = opts || {};
  var spawnMocha = new SpawnMocha(opts);
  var stream = through(function write(file) {
    spawnMocha.add(file.path);
  }, function() {});
  var errors = [];
  spawnMocha.on('error', function(err) {
    console.error(err.toString());
    errors.push(err);
  }).on('end', function() {
    if(errors.length > 0) {
      console.error('ERROR SUMMARY: ');
      _(errors).each(function(err) {
        console.error(err);
        console.error(err.stack);
      });
      stream.emit('error', "Some tests failed.");
    }
    stream.emit('end');
  });
  return stream;
};

module.exports = {
  SpawnMocha: SpawnMocha,
  mochaStream: mochaStream
};
