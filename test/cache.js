/// <reference path="../nodelib/node.js"/>
/// <reference path="../nodelib/mocha.js"/>
/// <reference path="../nodelib/should.js"/>
/// <reference path="../index.js"/>

var config = require('./config');
var Database = require('../index');
var Model = Database.Model;
var Instance = Database.Instance;
var should = require('should');
var Concoction = require('concoction');
var EventEmitter = require('events').EventEmitter;

function EventEmitterCache() {
	this.cache = {};
}

EventEmitterCache.prototype.__proto__ = EventEmitter.prototype;
EventEmitterCache.prototype.store = function(document, callback) {
	this.emit('store');
	var id = JSON.stringify(document._id);
	this.cache[id] = document;
	callback();
};
EventEmitterCache.prototype.fetch = function(id, callback) {
	id = JSON.stringify(id);
	if(this.cache[id]) this.emit('fetched');
	callback(this.cache[id]);
};
EventEmitterCache.prototype.drop = function(id, callback) {
	id = JSON.stringify(id);
	if(this.cache[id]) {
		delete this.cache[id];
		this.emit('dropped');
	}
	callback();
};

describe('orm', function () {
	"use strict";

	describe('Model', function () {
		var db = null;

		before(function (done) {
			db = new Database(config);
			db.connect(done);
		});

		describe('cache', function() {
			var model = null;

			before(function(done) {
				model =  new Model(db, 'model', {
					name: /.+/
				}, {
					preprocessors: [new Concoction.Rename({ _id: 'name' })],
					cache: new EventEmitterCache()
				});

				model.remove(function(err) {
					if(err) return done(err);

					model.create({
						name: 'Demo1'
					}, function(err, instance) {
						if(err) return done(err);
						return done();
					});
				});
			});

			describe('findOne', function() {
				it('should store newly retrieved documents in the cache', function(done) {
					var pending = 2;
					function almostDone() {
						if(!(--pending)) return done();
					}

					model.cache.once('store', almostDone);

					model.findOne('Demo1', function(err, instance) {
						should.not.exist(err);
						should.exist(instance);
						almostDone();
					});
				});

				it('should fetch retrieved documents from the cache', function(done) {
					var pending = 2;
					function almostDone() {
						if(!(--pending)) return done();
					}

					model.cache.once('fetched', almostDone);

					model.findOne('Demo1', function(err, instance) {
						should.not.exist(err);
						should.exist(instance);
						almostDone();
					});
				});
			});
		});
	});
});
