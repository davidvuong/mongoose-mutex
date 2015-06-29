mongoose-mutex
==============

Version: 0.1.1

Easily acquire arbitrary mutual exclusions via your mongoose connections. They're logical mutexes, not object locks.
Interaction with this module is done via A+ conformant promises. The RSVP module was used, so their promises will be returned.

## Installation

    npm install mongoose-mutex --save

## Quick reference

    var mongoose = require('mongoose'),
        MongooseMutex = require('mongoose-mutex');

    mongoose.connect('mongodb://localhost/example');

    // Provide a mongoose connection - it should be active and ready to go
    MongooseMutex.default.connection = mongoose;

    new MongooseMutex('doctorSignOff').promise
        .then(function(free) {
            // Check if enough doctors are in office
            // Approve sign off if clear

            // Two doctors can't sign off at the same time to abuse race conditions

            // Transaction complete
            return free();
        }, function(err) {
            // Failed to acquire mutual exclusion (DB connection may have failed, or
            // another doctor might've been signing off)
            console.log(err);
        });

### Advanced

    var mongoose = require('mongoose'),
        MongooseMutex = require('mongoose-mutex');

    mongoose.connect('mongodb://localhost/example');
    MongooseMutex.default.connection = mongoose;

    // You can provide custom connections on construction
    var secretConnection = mongoose.createConnection('mongodb://localhost/secret');

    var mutex = new MongooseMutex('secretOperation', {
        connection: secretConnection,
        idle: true,                     // You can defer execution of the mutex
        timeLimit: 60 * 5 * 1000        // You can change the timeLimit (default 15s)
    });
    
    // If you're going to do this often, you can change the defaults instead
    MongooseMutex.default.idle = true;
    MongooseMutex.default.timeLimit = 60 * 5 * 1000;
    // Now you don't need to specify these options on construction unless you want to
    // provide another different value

    mutex.claim()                          // Start a defered mutex with `#claim()`
        .then(function(free) {
            // We're in
        });

    mutex.promise
        .then(function(free) {
            // We're also in

            // Only use `.promise` after `#claim()`, because `#claim()` will provide a new value
            // each time you call it

            // You can use the `free` parameter from `mutex.promise`, or `mutex.free` anywhere
            // This also returns a promise so we can wait for it to be freed
        })
        .then(mutex.free)
        .then(someFn)
        .then(mutex.claim)                 // After being `#free()`d, you can `#claim()` again
        .then(anotherFn)
        .then(mutex.free);

You can see many more examples and usage patterns in the test suite.

## Detailed usage

### MongooseMutex.default

This object is refered to in the construction of MongooseMutex objects. Default values will be
read from this object, overridden by explicit options (if provided), and used in construction.
After construction this object is no longer referred to. It is mainly here for convenience.

This object defaults to:

    {
        connection: undefined,
        idle: false,
        timeLimit: 15000                // 15 seconds
    }

### new MongooseMutex(slug, options);

Construction requires a string for a slug which will be used as the scope for mutual exclusion.

#### slug

`new MongooseMutex('register-bob');` will only allow one `'register-bob'` in at any particular
time (so Bob can't cheat and double register), but a `new MongooseMutex('register-mary');` will
have no problem getting access while Bob is registering.

Mutual exclusion should be used for critical blocks of code with a highly granular locking level.
`'register-bob'` could be considered granular as not many people with the username `'bob'` will
be registering (and it'd be a weird case if many people were trying to register with the same
username), whereas a slug of `'register'` on it's own would be problematic as many instances will
be trying to acquire the same logical exclusion - this will lock up an application with many users.

You should provide adequate thought and care to slug selection. Granularity is key, but if overdone
you may miss the point entirely.

#### options

The `options` parameter is optional. If provided, you only need to provide values which differ
from those present in `MongooseMutex.default`.

##### options.connection

The mongoose connection that this object will use to create a model and query the database.

Every MongooseMutex object requires a connection. As such, it is recommended to specify a
default connection as if one isn't set nor explicitly provided on construction, an error will
be thrown.

The mongoose object it self is a connection once you've run `mongoose.connect`:

    var mongoose = require('mongoose'),
        MongooseMutex = require('mongoose-mutex');

    mongoose.connect('mongodb://localhost/example');
    MongooseMutex.default.connection = mongoose;

You can use more complicated mongoose connections if required:

    var otherConnection = mongoose.createConnection('mongodb://localhost/other');
    var mutex = new MongooseMutex('slug', { idle: true, connection: otherConnection });

##### options.idle

A MongooseMutex object will not try to acquire mutual exclusion immediately if `options.idle` is
truthy. As such, there will be no initial value for `mutex.promise` until `#claim()` is called.

This allows you to defer usage of MongooseMutex objects until required:

    var mutex = new MongooseMutex('slug', { idle: true });

    // When ready:
    mutex.claim()
        .then(...)
        .then(mutex.free);

If initialised with a falsy `options.idle`, `#claim()` will be implicitly called at the end of
construction and you'll be able to access `mutex.promise` immediately:

    // This allows basic usage without assigning the mutex to a variable
    new MongooseMutex('slug').promise
        .then(function(free) {
            ...
            return free();
        });

    // Notice that you don't need to call `#claim()`
    var mutex = new MongooseMutex('slug2');
    mutex.promise
        .then(...)
        .then(mutex.free);

##### options.timeLimit

Unfortunately, no matter how hard you try, there is a chance that you won't be able to `#free()`
your claimed mutex. As such, some sort of time limit is required after which the mutex will be
considered expired so another mutex can go ahead and claim it despite yours not being freed.

A time limit guarantees the claim/free loop regardless of what happens in the real world.

By default, this is set to 15 seconds (15,000 milliseconds). If you know a particular mutex's
code will require either a very short or very long period of time to complete execution, you
should adjust this limit appropriately.

Note that this should be considered an upper bound for the time a task may take - you should not
risk having a task still underway when the time limit is reached, as then another mutex may be
granted access and you'll have two instances of that task being run simultaneously, which
removes the point of using the mutex entirely. See the caveats section for more details.

Also note that the time taken to claim mutual exclusion is INCLUDED in the time limit. That is,
the time limit doesn't start ticking once `mutex.promise` is resolved, but rather when
`#claim()` is called. You should be careful with small limits as delays between your Node and
Mongo servers could use up a good deal of the time limit.

### #claim()

Use this function to launch an attempt to claim mutual exclusion. It will be implicitly called
at the end of a MongooseMutex object's construction if `idle != true`. If initialised idle,
you'll need to manually call this function before anything will happen.

This function returns a promise which will be resolved when mutual exclusion has been
successfully claimed. The promise will provide callback functions with one parameter: the
free function so it can be called without holding the mutex in a variable:

    new MongooseMutex('slug3').promise
        .then(function(free) {
            ...
            return free();
        });

Note that the free parameter from the promise is exactly equal to `mutex.free`. It is simply
provided there to allow usage like above.

This function sets `mutex.promise` to the return value:

    var mutex = new MongooseMutex('slug4', { idle: true });
    console.log(mutex.promise === mutex.claim());
    // false

    mutex.promise.then(mutex.free);

    mutex = new MongooseMutex('slug5', { idle: true });
    console.log(mutex.claim() === mutex.promise);
    // true

    mutex.promise.then(mutex.free);

If claiming mutual exclusion fails, the promise will be rejected. It could either fail due
to database connection errors, or because someone else is holding mutual exclusion and their
lock has not yet expired or been freed. An error will be thrown describing whether it was
a database error or mutex error that caused rejection.

After being freed, you can call the claim function again (and it will need to be freed again).

Once this function is called, `mutex.idle` is set to false.
You cannot call the claim function if `mutex.idle == false`.

### #free()

The free function should be called once your critical block of code is complete and standard,
non-mutually-exclusive execution can continue. In general you want this to be as soon as
possible so there are less blockages in your application - only critical code should be in
mutexes.

The function returns a promise which will be resolved when the mutex is successfully freed.
Once successfully freed, `mutex.idle` is set back to true so you can call the claim function
again.

The promise may be rejected with a thrown error if a database connection error occurs. Even
if this is to happen, `mutex.idle` is still set back to true.

This function will wait for `mutex.promise` to resolve before going itself. If `#claim()`
failed then this will fail too.

Once this function is called, you should not read `mutex.promise` again until `#claim()` is
called because it will re-assign a value to that property. See `mutex.promise` for more
details.

### .idle

This is a read only property - do not change the value.

This is a boolean which indicates whether the mutex is active or not.
It is initially false until `#claim()` is called.

If `options.idle == false` during construction then `#claim()` will be called immediately
and this will hence be set to true.

It will be set to false once the promise returned by `#free()` is resolved or rejected.

### .promise

This is a read only property - do not change the value.

You should only read this property while `mutex.idle == false`. The value is indeterminate
before `#claim()` and after `#free()`. This is because the A+ promise specification states
that promises can only be resolved or rejected once. As such, a new promise must be used
each time `#claim()` is called and therefore this property must be assigned a new value
each time:

    var mutex = new MongooseMutex('slug6');

    var promise1 = mutex.promise;

    mutex.promise
        .then(mutex.free)
        .then(mutex.go)
        .then(function() {
            console.log(promise1 === mutex.promise);
            // false
        });
        .then(mutex.free);

This promise will be resolved or rejected when `#claim()` is or is not successful. You
should wait for resolution before executing the critical code intended for the mutex.

This is wrong:

    var mutex = new MongooseMutex('oops', { idle: true });
    mutex.go();

    // Critical code now
    ...
    ..
    .

    // This code will not wait for mutual exclusion to be claimed and will execute even
    // if it fails to be claimed :(

The critical code must be executed after the promise has been resolved:

    new MongooseMutex('better').promise
        .then(function(free) {
            // Critical code now
            ...
            ..
            .

            return free();
        });

### .timeLimit

This is a read only property - do not change the value.

This property lets you read the time limit which the mutex was constructed with. If you
need to change the time limit, create a new mutex instead of writing over this value.

## Caveats

### Exceeding the time limit

One thing that can go wrong here is if the code you have running in the mutex continues
executing after the mutex has expired. Other attempts at claiming the mutex will succeed
in this case, and things can go off the rails for you.

It is assumed that you've considered the needs of your critical code section and have
selected an appropriate limit that will ensure the mutex will be freed before it expires.

### Failing to free

A record is created in the database when a mutex is claimed. That record is removed once
freed to avoid gradual clutter of the database. This is necessary when considering large
scale applications which may have multiple uses of mutexes which use IDs as part of the
slug - billions of records may pile up.

However as a result, if you fail to free a mutex, it will remain in the database until
claimed and freed again. This is only problematic if you fail to free the mutex often -
the aforementioned clutter will again occur. You should have some form of monitoring in
place such to notice if failures are occurring often.

## Tests

A test suite has been implemented. It attempts to connect to `'mongodb://localhost/test'`,
so you need to let that connection succeed.

To run the tests, ensure your MongoDB instance is running, for instance via:

    mongod --config /usr/local/etc/mongod.conf

Then `cd` into the `mongoose-mutex` directory, `npm install` (without `--production`), and:

    npm test

## Release history

* 0.1.0
  * Initial release with passing test suite, ready to publish.
