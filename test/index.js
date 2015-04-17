var should = require('should'),
    RSVP = require('rsvp'),
    mongoose = require('mongoose'),
    _ = require('lodash'),
    
    MongooseMutex = require('../index'),
    util = require('./lib/util');

var mutexTimeLimit = 1000;

mongoose.connect('mongodb://localhost/test');

/*
    MongooseMutex.defaults = {
        connection: undefined,
        idle: false,
        timeLimit: 15000
    }

Modify this object at your will.

All new instances will copy those defaults to various instance variables (see
below), but can be modified individually via the options parameter during
construction. They should NOT be modified after that - consider them read only.

Instance variables and methods existing after construction should not be written
to, and are:

    #go()
    #free()
    .timeLimit
    .idle
    .promise

    ._connection
    ._model
*/

// TODO (wrap all tests in util.allErrors)

describe('MongooseMutex', function() {
    beforeEach(function(done) {
        var total = Object.keys(mongoose.connection.collections).length;
        if(total === 0) return done();

        var removed = 0;
        for(var i in mongoose.connection.collections) {
            mongoose.connection.collections[i].remove(function() {
                // TODO (handle errors)
                if(++removed === total)
                    done();
            });
        }
    });
    
    describe('construction', function() {
        it('should throw if no explicit or default mongoose connection is provided', function() {
            (function() {
                new MongooseMutex('n/a', { idle: true });
            }).should.throw('No mongoose connection');
        });
        
        it('should not throw if an explicit mongoose connection is provided', function() {
            (function() {
                new MongooseMutex('n/a', { idle: true, connection: mongoose });
            }).should.not.throw();
        });
        
        it('should not throw if a default mongoose connection is provided', function() {
            MongooseMutex.defaults.connection = mongoose;
            
            (function() {
                new MongooseMutex('n/a', { idle: true });
            }).should.not.throw();
        });

        it('should take values from MongooseMutex.defaults which can be overridden individually', function() {
            var weirdTimeLimit = 10;

            MongooseMutex.defaults.idle = true;
            MongooseMutex.defaults.timeLimit = weirdTimeLimit;

            var mutex = new MongooseMutex('n/a');
            mutex.idle.should.be.true;
            mutex.timeLimit.should.equal(weirdTimeLimit);

            // These defaults will affect all tests, so we'll set them to good values.
            MongooseMutex.defaults.idle = false;
            MongooseMutex.defaults.timeLimit = mutexTimeLimit;

            var mutex = new MongooseMutex('n/a', { idle: true });
            mutex.idle.should.be.true;
            mutex.timeLimit.should.equal(mutexTimeLimit);

            var mutex = new MongooseMutex('n/a', { idle: true, timeLimit: weirdTimeLimit });
            mutex.timeLimit.should.equal(weirdTimeLimit);
        });
    });
    
    describe('#go()', function() {
        it('should update and return .promise', function() {
            var mutex = new MongooseMutex('n/a', { idle: true });
            
            var promise = mutex.go();
            promise.should.equal(mutex.promise);

            return promise
                .then(mutex.free)
                .then(function() {
                    promise = mutex.go();
                    promise.should.equal(mutex.promise);
                    
                    return promise.then(mutex.free).catch(util.nothing);
                })
                .catch(util.allErrors);
        });
        
        it('should correctly create a document in the "_mutex" collection', function() {
            var id = 'createTest',
                numTests = 3,
                mutex = new MongooseMutex(id, { idle: true });
            
            var previousTimestamp;
            function checkMutex() {
                return new RSVP.Promise(function(resolve) {
                    mutex._model.findOne({ _id: id }, function(err, doc) {
                        should.not.exist(err);
                        should.exist(doc);
                        
                        doc.timestamps.should.be.an.instanceOf('Array').and.have.lengthOf(1);
                        doc.timestamps[0].should.be.an.instanceOf('string').and.not.equal(previousTimestamp);
                        
                        var previousTimestamp = stamp = doc.timestamps[0];
                        var split = stamp.indexOf('-');
                        split.should.not.equal(-1);
                        
                        var rand = stamp.split(0, split);
                        parseInt(rand, 10).should.not.be.NaN;
                        
                        stamp = stamp.slice(split + 1);
                        (function() {
                            stamp = new Date(stamp);
                        }).should.not.throw();
                        stamp.should.be.greaterThan(_.now());
                        stamp.should.be.lessThan(_.now() + mutex.timeLimit);
                        
                        resolve();
                    });
                });
            }

            var promise = RSVP.resolve();
            for(var i = numTests; i != 0; --i) {
                promise = promise
                    .then(mutex.go)
                    .then(checkMutex)
                    .then(i === 1
                        ? function() { return mutex.free().catch(util.nothing); }
                        : mutex.free
                    );
            }

            return promise.catch(util.allErrors);
        });
        
        it('should remove it\'s document from the "_mutex" collection after being #free()d', function() {
            var id = 'removeTest',
                mutex = new MongooseMutex(id);
            
            function checkMutex(shouldExist) {
                return function() {
                    return new RSVP.Promise(function(resolve) {
                        mutex._model.findOne({ _id: id }, function(err, doc) {
                            should.not.exist(err);

                            if(shouldExist) should.exist(doc);
                            else            should.not.exist(doc);
                            
                            resolve();
                        });
                    });
                }
            }

            mutex.promise
                .then(checkMutex(true))
                .then(mutex.free)
                .then(checkMutex(false))
                .catch(util.allErrors);
        });
        
        it('should provide mutual exclusion under the same ID', function() {
            var id = 'mutexTest',
                numMutexes = 4,
                mutexes = _.map(_.range(numMutexes), function() { return new MongooseMutex(id); });
            
            var resolved = 0;
            
            return RSVP.all(_.map(mutexes, function(mutex) {
                return mutex.promise
                    .then(function(free) {
                        resolved++;
                        return free;
                    }, function(err) {
                        // TODO (use should and be careful)
                        if((err && err.message || err) != 'Failed to acquire mutual exclusion')
                            throw err;
                    });
            })).then(function(frees) {
                resolved.should.equal(1);
                
                return RSVP.all(_.map(frees, function(free) {
                    return free ? free().catch(util.nothing) : RSVP.resolve();
                }));
            }).catch(util.allErrors);
        });
        
        it('should not lock mutexes under different IDs', function() {
            var id = 'dontLockTest',
                numMutexes = 4,
                mutexPromises = _.map(_.range(numMutexes), function(i) { return new MongooseMutex(id + i).promise; });
            
            return RSVP.all(mutexPromises)
                .then(function(frees) {
                    return RSVP.all(_.map(frees, function(free) {
                        return free().catch(util.nothing);
                    }));
                })
                .catch(util.allErrors);
        });
        
        it('should remove it\'s timestamp from the "_mutex" collection after rejection', function() {
            var id = 'failRemoveTest',
                mutex = new MongooseMutex(id),
                numTests = 3,
                failingMutexes = _.map(_.range(numTests), function() { return new MongooseMutex(id); });
            
            return mutex.promise
                .then(function() {
                    return new RSVP.Promise(function(resolve) {
                        mutex._model.findOne({ _id: id }, function(err, doc) {
                            should.not.exist(err);
                            should.exist(doc);

                            doc.timestamps.should.be.an.instanceOf('Array').and.have.lengthOf(1);
                            doc.timestamps[0].should.be.an.instanceOf('string');

                            resolve(doc.timestamps[0]);
                        });
                    });
                })
                .then(function(originalTimestamp) {
                    return RSVP.all(_.map(failingMutexes), function(mutex) {
                        return mutex.promise.then(function() {
                            // TODO (use should somehow so it will be thrown as an assertion)
                            throw new Error('Mutex should have failed');
                        }, function(err) {
                            // TODO (use should)
                            if((err && err.message || err) != 'Failed to acquire mutual exclusion')
                                throw err;
                        });
                    }).then(function() {
                        return new RSVP.Promise(function(resolve) {
                            mutex._model.findOne({ _id: id }, function(err, doc) {
                                should.not.exist(err);
                                should.exist(doc);
                                
                                doc.timestamps.should.be.an.instanceOf('Array').and.have.lengthOf(1);
                                doc.timestamps[0].should.be.an.instanceOf('string').and.equal(originalTimestamp);
                                
                                resolve();
                            });
                        });
                    })
                })
                .then(function() { return mutex.free().catch(util.nothing); })
                .catch(util.allErrors);
        });
        
        it('should not be rejected if a clashing timestamp has expired', function() {
            var id = 'timeLimitTest',
                numTests = 3,
                timeLimit = parseInt(mutexTimeLimit / numTests),
                mutex = new MongooseMutex(id, { idle: true, timeLimit: timeLimit });

            return _.reduce(_.range(numTests + 1), function(previousTimestampPromise) {
                return previousTimestampPromise.then(function(previousTimestamp) {
                    return new RSVP.Promise(function(resolve, reject) {
                        setTimeout(function() {
                            mutex.go().then(function() {
                                mutex._model.findOne({ _id: id }, function(err, doc) {
                                    should.not.exist(err);
                                    should.exist(doc);

                                    doc.timestamps.should.be.an.instanceOf('Array').and.have.lengthOf(1);
                                    doc.timestamps[0].should.be.an.instanceOf('string').and.not.equal(previousTimestamp);

                                    mutex = new MongooseMutex(id, { idle: true, timeLimit: timeLimit });

                                    resolve(doc.timestamps[0]);
                                });
                            }).catch(reject);
                        }, previousTimestamp ? timeLimit : 0); // Don't timeout if it's the first mutex (i.e. previousTimestamp === null)
                    });
                });
            }, RSVP.resolve()).catch(util.allErrors);
        });

        it('should throw if .idle != true', function() {
            var mutex = new MongooseMutex('n/a');
            
            var checkThrow = function() {
                (function() {
                    mutex.go();
                }).should.throw('Cannot go when not idle');
            };
            checkThrow();
            
            mutex.promise
                .then(mutex.free)
                .then(function() {
                    mutex.go();
                    checkThrow();
                    
                    return mutex.promise
                        .then(checkThrow)
                        .then(function() { return mutex.free().catch(util.nothing); });
                })
                .catch(util.allErrors);
        });
    });
    
    describe('#free()', function() {
        it('should be exactly equal to the free parameter from .promise', function() {
            var mutex = new MongooseMutex('n/a');
            
            mutex.promise
                .then(function(free) {
                    mutex.free.should.be.exactly(free);
                    
                    return free().catch(util.nothing);
                })
                .catch(util.allErrors);
        });
        
        it('should throw if .idle == true', function() {
            var mutex = new MongooseMutex('n/a', { idle: true });
            
            var checkThrow = function() {
                (function() {
                    mutex.free();
                }).should.throw('Cannot free idle mutex');
            };
            checkThrow();
            
            mutex.go()
                .then(mutex.free)
                .then(checkThrow)
                .catch(util.allErrors);
        });
    });
    
    describe('.idle', function() {
        it('should initially be true if options.idle == true', function() {
            var mutex = new MongooseMutex('n/a', { idle: true });
            mutex.idle.should.be.true;
        });
        
        it('should not initially be true if options.idle != true', function() {
            var mutex = new MongooseMutex('n/a');
            mutex.idle.should.not.be.true;
            
            return mutex.promise.then(mutex.free).catch(util.nothing);
        });
        
        it('should be correct before and after #go() and #free() if options.idle == true', function() {
            var mutex = new MongooseMutex('n/a', { idle: true });
            
            mutex.go();
            mutex.idle.should.be.false;
            
            return mutex.promise
                .then(function(free) {
                    mutex.idle.should.be.false;
                    return free();
                })
                .then(function() { mutex.idle.should.be.true; })
                .catch(util.allErrors);
        });
        
        it('should be correct before and after #free() if options.idle != true', function() {
            var mutex = new MongooseMutex('n/a');
            
            return mutex.promise
                .then(function(free) {
                    mutex.idle.should.be.false;
                    return free();
                })
                .then(function() { mutex.idle.should.be.true; })
                .catch(util.allErrors);
        });
    });
    
    after(function() {
        mongoose.disconnect();
    });
});
