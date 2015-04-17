var should = require('should'),
    RSVP = require('rsvp');

function isAssertionError(err) {
    return Boolean(err.toString().match(/^AssertionError/));
};

var m = {
    // Forward no error (useful if only connection errors would get through,
    // but we've tested everything we need to so we don't want to see these errors)
    nothing: function() {},
    
    // If the error is an assertion error, forward that. Otherwise provide an extra
    // description for the error since the one from the error on it's own may be
    // confusing without context
    allErrors: function(err) {
        if(isAssertionError(err))
            throw err;
        
        throw new Error('Error caught when working the mutex: ' + JSON.stringify(err));
    }
};

module.exports = m;
