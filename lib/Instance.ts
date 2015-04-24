﻿/// <reference path="../_references.d.ts" />
import iridium = require('./Core');
import Model = require('./Model');
import IPlugin = require('./Plugins');
import _ = require('lodash');
import Bluebird = require('bluebird');

import general = require('./General');

class Instance<TDocument, TInstance> {
    /**
     * Creates a new instance which represents the given document as a type of model
     * @param {model.Model} model The model that the document represents
     * @param {TSchema} document The document which should be wrapped by this instance
     * @param {Boolean} isNew Whether the document is new (doesn't exist in the database) or not
     * @param {Boolean} isPartial Whether the document has only a subset of its fields populated
     * @description
     * This class will be subclassed automatically by Iridium to create a model specific instance
     * which takes advantage of some of v8's optimizations to boost performance significantly.
     * The instance returned by the model, and all of this instance's methods, will be of type
     * TInstance - which should represent the merger of TSchema and IInstance for best results.
     */
    constructor(model: Model<TDocument, TInstance>, document: TDocument, isNew: boolean = true, isPartial: boolean = false) {
        this._model = model;

        this._isNew = !!isNew;
        this._isPartial = isPartial;
        this._original = document;
        this._modified = _.cloneDeep(document);

        _.each(model.core.plugins,(plugin: IPlugin) => {
            if (plugin.newInstance) plugin.newInstance(this, model);
        });
    }

    private _isNew: boolean;
    private _isPartial: boolean;
    private _model: Model<TDocument, TInstance>;
    private _original: TDocument;
    private _modified: TDocument;

    /**
     * Gets the underlying document representation of this instance
     */
    get document(): TDocument {
        return this._modified;
    }

    [name: string]: any;

    /**
     * Saves any changes to this instance, using the built in diff algorithm to write the update query.
     * @param {function(Error, IInstance)} callback A callback which is triggered when the save operation completes
     * @returns {Promise<TInstance>}
     */
    save(callback?: general.Callback<TInstance>): Bluebird<TInstance>;
    /**
     * Saves the given changes to this instance and updates the instance to match the latest database document.
     * @param {Object} changes The MongoDB changes object to be used when updating this instance
     * @param {function(Error, IInstance)} callback A callback which is triggered when the save operation completes
     * @returns {Promise<TInstance>}
     */
    save(changes: Object, callback?: general.Callback<TInstance>): Bluebird<TInstance>;
    /**
     * Saves the given changes to this instance and updates the instance to match the latest database document.
     * @param {Object} conditions The conditions under which the update will take place - these will be merged with an _id query
     * @param {Object} changes The MongoDB changes object to be used when updating this instance
     * @param {function(Error, IInstance)} callback A callback which is triggered when the save operation completes
     * @returns {Promise<TInstance>}
     */
    save(conditions: Object, changes: Object, callback?: general.Callback<TInstance>): Bluebird<TInstance>;
    save(...args: any[]): Bluebird<TInstance> {
        var callback: general.Callback<any> = null;
        var changes: any = null;
        var conditions: any = {};

        Array.prototype.slice.call(args, 0).reverse().forEach((arg) => {
            if (typeof arg == 'function') callback = arg;
            else if (typeof arg == 'object') {
                if (!changes) changes = arg;
                else conditions = arg;
            }
        });

        return Bluebird.resolve().then(() => {
            _.merge(conditions, this._model.helpers.selectOneDownstream(this._modified));

            this._model.helpers.transform.reverse(conditions);

            if (!changes) {
                var validation = this._model.helpers.validate(this._modified);
                if (validation.failed) return Bluebird.reject(validation.error).bind(this).nodeify(callback);

                var original = _.cloneDeep(this._original);
                var modified = _.cloneDeep(this._modified);

                changes = this._model.helpers.diff(original, modified);
            }

            if (!_.keys(changes).length) return null;

            return changes;
        }).then((changes) => {
            if (!changes && !this._isNew) return changes;
            return this._model.handlers.savingDocument(<TInstance><any>this, changes).then(() => changes);
        }).then((changes) => {
            if (!changes && !this._isNew) return false;

            if (this._isNew) return new Bluebird<boolean>((resolve, reject) => {
                this._model.collection.insert(this._modified,(err, doc) => {
                    if (err) return reject(err);
                    return resolve(<any>!!doc);
                });
            });

            return new Bluebird<boolean>((resolve: (changed: boolean) => void, reject) => {
                this._model.collection.update(conditions, changes, { w: 1 },(err: Error, changed: boolean) => {
                    if (err) return reject(err);
                    return resolve(changed);
                });
            });
        }).then((changed: boolean) => {
            conditions = this._model.helpers.selectOne(this._modified);
            if (!changed) {
                var document = _.cloneDeep(this._modified);
                this._model.helpers.transform.reverse(document);
                return document;
            }

            return new Bluebird<TDocument>((resolve, reject) => {
                this._model.collection.findOne(conditions,(err: Error, latest) => {
                    if (err) return reject(err);
                    return resolve(latest);
                });
            });
        }).then((latest: TDocument) => {
            return this._model.handlers.documentReceived(conditions, latest,(value) => {
                this._model.helpers.transform.apply(value);
                this._isPartial = false;
                this._isNew = false;
                this._original = value;
                this._modified = _.clone(value);
                return <TInstance><any>this;
            });
        }).nodeify(callback);
    }

    /**
     * Updates this instance to match the latest document available in the backing collection
     * @param {function(Error, IInstance)} callback A callback which is triggered when the update completes
     * @returns {Promise<TInstance>}
     */
    update(callback?: general.Callback<TInstance>): Bluebird<TInstance> {
        return this.refresh(callback);
    }

    /**
     * Updates this instance to match the latest document available in the backing collection
     * @param {function(Error, IInstance)} callback A callback which is triggered when the update completes
     * @returns {Promise<TInstance>}
     */
    refresh(callback?: general.Callback<TInstance>): Bluebird<TInstance> {
        var conditions = this._model.helpers.selectOne(this._original);

        return Bluebird.resolve().then(() => {
            return new Bluebird<TDocument>((resolve, reject) => {
                this._model.collection.findOne(conditions,(err: Error, doc: any) => {
                    if (err) return reject(err);
                    return resolve(doc);
                });
            });
        }).then((newDocument) => {
            if (!newDocument) {
                this._isPartial = true;
                this._isNew = true;
                this._original = _.cloneDeep(this._modified);
                return <Bluebird<TInstance>><any>this;
            }

            return this._model.handlers.documentReceived<TDocument>(conditions, newDocument,(doc) => {
                this._model.helpers.transform.apply(doc);
                return doc;
            }).then((doc) => {
                this._isNew = false;
                this._isPartial = false;
                this._original = doc;
                this._modified = _.cloneDeep(doc);

                return <TInstance><any>this;
            });
        }).nodeify(callback);
    }

    /**
     * Removes this instance's document from the backing collection
     * @param {function(Error, IInstance)} callback A callback which is triggered when the operation completes
     * @returns {Promise<TInstance>}
     */
    delete(callback?: general.Callback<TInstance>): Bluebird<TInstance> {
        return this.remove(callback);
    }

    /**
     * Removes this instance's document from the backing collection
     * @param {function(Error, IInstance)} callback A callback which is triggered when the operation completes
     * @returns {Promise<TInstance>}
     */
    remove(callback?: general.Callback<TInstance>): Bluebird<TInstance> {
        var conditions = this._model.helpers.selectOne(this._original);

        return Bluebird.resolve().then(() => {
            if (this._isNew) return 0;
            return new Bluebird<number>((resolve, reject) => {
                this._model.collection.remove(conditions,(err: Error, removed?: any) => {
                    if (err) return reject(err);
                    return resolve(removed);
                });
            });
        }).then((removed) => {
            if (removed) return this._model.cache.clear(conditions);
            return false;
        }).then((removed) => {
            this._isNew = true;
            return <TInstance><any>this;
        }).nodeify(callback);
    }

    /**
     * Retrieves the first element in an enumerable collection which matches the predicate
     * @param {any[]} collection The collection from which to retrieve the element
     * @param {function(any, Number): Boolean} predicate The function which determines whether to select an element
     * @returns {any}
     */
    first<T>(collection: T[], predicate: general.Predicate<T>): T;
    /**
     * Retrieves the first element in an enumerable collection which matches the predicate
     * @param {Object} collection The collection from which to retrieve the element
     * @param {function(any, String): Boolean} predicate The function which determines whether to select an element
     * @returns {any}
     */
    first<T>(collection: { [key: string]: T }, predicate: general.Predicate<T>): T;
    first<T>(collection: T[]| { [key: string]: T }, predicate: general.Predicate<T>): T {
        var result = null;

        _.each(collection,(value: T, key) => {
            if (predicate.call(this, value, key)) {
                result = value;
                return false;
            }
        });

        return result;
    }

    /**
     * Retrieves a number of elements from an enumerable collection which match the predicate
     * @param {any[]} collection The collection from which elements will be plucked
     * @param {function(any, Number): Boolean} predicate The function which determines the elements to be plucked
     * @returns {any[]}
     */
    select<T>(collection: T[], predicate: general.Predicate<T>): T[];
    /**
     * Retrieves a number of elements from an enumerable collection which match the predicate
     * @param {Object} collection The collection from which elements will be plucked
     * @param {function(any, String): Boolean} predicate The function which determines the elements to be plucked
     * @returns {Object}
     */
    select<T>(collection: { [key: string]: T }, predicate: general.Predicate<T>): { [key: string]: T };
    select<T>(collection: T[]| { [key: string]: T }, predicate: general.Predicate<T>): any {
        var isArray = Array.isArray(collection);
        var results: any = isArray ? [] : {};

        _.each(collection,(value: T, key) => {
            if (predicate.call(this, value, key)) {
                if (isArray) results.push(value);
                else results[key] = value;
            }
        });

        return results;
    }

    /**
     * Gets the JSON representation of this instance
     * @returns {TDocument}
     */
    toJSON(): TDocument {
        return this.document;
    }

    /**
     * Gets a string representation of this instance
     * @returns {String}
     */
    toString(): string {
        return JSON.stringify(this.document, null, 2);
    }
}

export = Instance;