#include "check.h"

#include <cstring>
#include <exception>

std::vector<TestCase>& allTests ()
{
    static std::vector<TestCase> tests;
    return tests;
}

int gFailures = 0;

int main (int argc, char** argv)
{
    const char* filter { argc > 1 ? argv[1] : nullptr };
    int ran { 0 };
    for (auto& test : allTests ())
    {
        if (filter && ! std::strstr (test.name, filter))
            continue;
        std::printf ("[ RUN  ] %s\n", test.name);
        const int before { gFailures };
        try
        {
            test.run ();
        }
        catch (const std::exception& e)
        {
            std::printf ("    unexpected exception: %s\n", e.what ());
            ++gFailures;
        }
        std::printf (gFailures == before ? "[  OK  ] %s\n" : "[ FAIL ] %s\n", test.name);
        ++ran;
    }
    std::printf ("%d test(s), %d failure(s)\n", ran, gFailures);
    return (ran > 0 && gFailures == 0) ? 0 : 1;
}
