#define PY_SSIZE_T_CLEAN
#include <Python.h>
#include <math.h>

// We use nearbyint() to implement bankers rounding (ties-to-even) under the
// default IEEE-754 rounding mode (FE_TONEAREST). This matches Python's
// float round() behaviour for the coordinate ranges and ndigits used by this
// engine (4..8). See tests for equivalence checks.
static inline double
round_bankers_ndigits(double x, int ndigits)
{
    if (!isfinite(x) || ndigits < 0) {
        // Engine only uses non-negative ndigits for cache precision.
        return x;
    }

    // Precomputed powers of 10 for ndigits 0..9
    static const double pow10[] = {
        1.0,
        10.0,
        100.0,
        1000.0,
        10000.0,
        100000.0,
        1000000.0,
        10000000.0,
        100000000.0,
        1000000000.0,
    };

    double scale;
    if (ndigits <= 9) {
        scale = pow10[ndigits];
    } else {
        scale = pow(10.0, (double)ndigits);
    }
    if (!isfinite(scale) || scale == 0.0) {
        return x;
    }

    double y = x * scale;
    if (!isfinite(y)) {
        return x;
    }
    double r = nearbyint(y) / scale;
    // Preserve signed zero behaviour.
    if (r == 0.0) {
        r = copysign(0.0, x);
    }
    return r;
}

static PyObject *
distance_cache_key(PyObject *self, PyObject *args)
{
    double lat1, lng1, lat2, lng2;
    int ndigits;
    if (!PyArg_ParseTuple(args, "ddddi", &lat1, &lng1, &lat2, &lng2, &ndigits)) {
        return NULL;
    }

    double rlat1 = round_bankers_ndigits(lat1, ndigits);
    double rlng1 = round_bankers_ndigits(lng1, ndigits);
    double rlat2 = round_bankers_ndigits(lat2, ndigits);
    double rlng2 = round_bankers_ndigits(lng2, ndigits);

    PyObject *out = PyTuple_New(4);
    if (!out) {
        return NULL;
    }
    PyTuple_SET_ITEM(out, 0, PyFloat_FromDouble(rlat1));
    PyTuple_SET_ITEM(out, 1, PyFloat_FromDouble(rlng1));
    PyTuple_SET_ITEM(out, 2, PyFloat_FromDouble(rlat2));
    PyTuple_SET_ITEM(out, 3, PyFloat_FromDouble(rlng2));
    return out;
}

static PyObject *
round_coord(PyObject *self, PyObject *args)
{
    double value;
    int ndigits;
    if (!PyArg_ParseTuple(args, "di", &value, &ndigits)) {
        return NULL;
    }
    return PyFloat_FromDouble(round_bankers_ndigits(value, ndigits));
}

static PyMethodDef Methods[] = {
    {"distance_cache_key", distance_cache_key, METH_VARARGS,
     "distance_cache_key(lat1,lng1,lat2,lng2, ndigits) -> (r1,r2,r3,r4)"},
    {"round_coord", round_coord, METH_VARARGS,
     "round_coord(value, ndigits) -> float"},
    {NULL, NULL, 0, NULL}
};

static struct PyModuleDef moduledef = {
    PyModuleDef_HEAD_INIT,
    "_distance_ext",
    "Compiled distance-cache key helpers.",
    -1,
    Methods,
    NULL,
    NULL,
    NULL,
    NULL,
};

PyMODINIT_FUNC
PyInit__distance_ext(void)
{
    return PyModule_Create(&moduledef);
}

